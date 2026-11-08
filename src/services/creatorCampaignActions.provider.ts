import { createHash } from "node:crypto";
import { CREATOR_BINDING as binding, bangkokDay, minor } from "./creatorRead.service";
import { WEB_BUDGET_CAMPAIGN_ID as id, WEB_BUDGET_MAX_MINOR as maxMinor } from "./creatorWebBudget.service";

const HOST = "https://business-api.tiktok.com/open_api/v1.3";
const LIST = "/gmv_max/campaign/get/", INFO = "/campaign/gmv_max/info/", SPEND = "/report/integrated/get/";
// The official incremental GMV Max update docs direct ON/OFF to the distinct status endpoint.
const ROI = "/campaign/gmv_max/update/", STATUS = "/campaign/status/update/";
const CAP = 1_048_576;
type Data = Record<string, unknown>;
export type CampaignSwitch = "ENABLE" | "DISABLE";
export type CampaignAction = "SET_ROI" | "PAUSE" | "RESUME";
export type CampaignActionSnapshot = { campaignId: string; campaignName: string; operationStatus: CampaignSwitch;
  roiTargetTenths: number; observedAt: string; fingerprint: string; fixedFingerprint: string; budgetMinor: number;
  scheduleOpen: boolean; nativeAutoOff: boolean };
export type CampaignActionTarget = { status: CampaignSwitch; roiTenths: number };
export type CampaignActionOutcome = "NOT_SENT" | "APPLIED_VERIFIED" | "OUTCOME_UNKNOWN";
export class CampaignActionError extends Error {
  constructor(readonly code: string, readonly httpStatus: number, message: string) { super(message); }
}
const unavailable = (): never => { throw new CampaignActionError("CAMPAIGN_UNAVAILABLE", 503, "ยังยืนยันข้อมูลแคมเปญจาก TikTok ไม่ได้"); };
const object = (v: unknown): Data => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Data : unavailable();
const hasId = (v: unknown): v is string => typeof v === "string" && id.test(v);
const isSwitch = (v: unknown): v is CampaignSwitch => v === "ENABLE" || v === "DISABLE";
export const validRoiTenths = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= 9999;
function stamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const iso = value.replace(" ", "T") + ".000Z", time = Date.parse(iso);
  return Number.isFinite(time) && new Date(time).toISOString() === iso ? time : null;
}
const noShop = (v: unknown) => v == null || v === "" || v === "0";
function hash(v: unknown) { return createHash("sha256").update(JSON.stringify(v)).digest("hex"); }
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)]));
  return v;
}
async function json(response: Response): Promise<Data> {
  if (!response.body || Number(response.headers.get("content-length")) > CAP) return unavailable();
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const value = await reader.read();
      if (value.done) break;
      bytes += value.value.length;
      if (bytes > CAP) { void reader.cancel().catch(() => undefined); return unavailable(); }
      chunks.push(Buffer.from(value.value));
    }
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally { reader.releaseLock(); }
}

export function createPpanCampaignActionProvider({ loadToken, fetchImpl = fetch, now = () => new Date() }:
  { loadToken: () => Promise<string>; fetchImpl?: typeof fetch; now?: () => Date }) {
  async function token() {
    const value = await loadToken();
    if (typeof value !== "string" || !/^[^\x00-\x20\x7f]{16,4096}$/.test(value)) return unavailable();
    return value;
  }
  async function get(path: typeof LIST | typeof INFO | typeof SPEND, params: Record<string, string | number>, key: string) {
    const url = new URL(HOST + path);
    url.searchParams.set("advertiser_id", binding.advertiserId);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
    const res = await fetchImpl(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { "Access-Token": key, Accept: "application/json", "Cache-Control": "no-cache" } });
    const result = await json(res);
    if (!res.ok || result.code !== 0) return unavailable();
    return object(result.data);
  }
  async function list(key: string, campaignId?: string) {
    const rows: Array<{ campaignId: string; status: CampaignSwitch | "DELETE"; modified: number }> = [];
    const seen = new Set<string>(); let total: unknown, pages: unknown;
    for (let page = 1; page <= (campaignId ? 1 : 5); page++) {
      const data = await get(LIST, { filtering: JSON.stringify({ gmv_max_promotion_types: ["LIVE_GMV_MAX"], ...(campaignId ? { campaign_ids: [campaignId] } : {}) }),
        fields: JSON.stringify(["advertiser_id", "campaign_id", "operation_status", "modify_time"]), page, page_size: 100 }, key);
      const pagination = object(data.page_info), n = pagination.total_number, p = pagination.total_page;
      if (!Array.isArray(data.list) || data.list.length > 100 || pagination.page !== page || typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 ||
        typeof p !== "number" || !Number.isSafeInteger(p) || p < 0 || (p === 0 && data.list.length !== 0) || (p > 0 && p < page) ||
        (page > 1 && (n !== total || p !== pages))) return unavailable();
      total = n; pages = p;
      for (const x of data.list) {
        const row = object(x), modified = stamp(row.modify_time);
        if (!hasId(row.campaign_id) || row.advertiser_id !== binding.advertiserId || seen.has(row.campaign_id) ||
          (!isSwitch(row.operation_status) && row.operation_status !== "DELETE") || modified === null || (campaignId && row.campaign_id !== campaignId)) return unavailable();
        seen.add(row.campaign_id); rows.push({ campaignId: row.campaign_id, status: row.operation_status, modified });
      }
      if (page >= p) break;
      if (page === (campaignId ? 1 : 5)) return unavailable();
    }
    if (rows.length !== total || (campaignId && rows.length > 1)) return unavailable();
    return rows;
  }
  async function snapshot(key: string, row: Awaited<ReturnType<typeof list>>[number]): Promise<CampaignActionSnapshot> {
    if (!isSwitch(row.status)) return unavailable();
    const data = await get(INFO, { campaign_id: row.campaignId }, key);
    if (data.advertiser_id !== binding.advertiserId || data.campaign_id !== row.campaignId || data.shopping_ads_type !== "LIVE" ||
      data.operation_status !== row.status || data.store_id !== "0" || data.store_authorized_bc_id !== "0" ||
      (data.tiktok_account_id !== undefined && data.tiktok_account_id !== binding.tiktokAccountId) ||
      data.deep_bid_type !== "VO_MIN_ROAS" || data.optimization_goal !== "VALUE" || !Array.isArray(data.identity_list) || data.identity_list.length !== 1) return unavailable();
    const identity = object(data.identity_list[0]);
    if (identity.identity_id !== binding.identityId || identity.identity_type !== binding.identityType ||
      identity.identity_authorized_bc_id !== binding.identityAuthorizedBcId || !noShop(identity.store_id) || !noShop(identity.identity_authorized_shop_id)) return unavailable();
    const budgetMinor = minor(data.budget), roiTargetTenths = typeof data.roas_bid === "number" ? Math.round(data.roas_bid * 10) : NaN;
    if (!validRoiTenths(roiTargetTenths) || data.roas_bid !== roiTargetTenths / 10 || budgetMinor <= 0 || budgetMinor > maxMinor) return unavailable();
    const start = stamp(data.schedule_start_time), end = stamp(data.schedule_end_time), withEnd = data.schedule_type === "START_END" || data.schedule_type === "SCHEDULE_START_END";
    if ((data.schedule_type !== "FROM_NOW" && data.schedule_type !== "SCHEDULE_FROM_NOW" && !withEnd) || start === null ||
      (data.schedule_end_time != null && end === null) || (withEnd && end === null)) return unavailable();
    const at = now(), scheduleOpen = start <= at.getTime() && (end === null || end > at.getTime());
    const native = data.auto_budget == null ? {} : object(data.auto_budget), promotion = data.promotion_days == null ? {} : object(data.promotion_days);
    const nativeValues = [data.auto_budget_enabled, native.auto_budget_enabled, native.is_enabled];
    const nativeAutoOff = nativeValues.includes(false) && nativeValues.every(x => x === false || x == null) && (promotion.is_enabled === false || promotion.is_enabled == null);
    const name = typeof data.campaign_name === "string" ? data.campaign_name.split(key).join("[REDACTED]").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, 160).trim() : "";
    const fixedFingerprint = hash(stable([row.campaignId, binding.advertiserId, binding.identityId, budgetMinor, data.campaign_name,
      data.schedule_type, data.schedule_start_time, data.schedule_end_time ?? null, data.auto_budget_enabled ?? null, native, promotion]));
    return { campaignId: row.campaignId, campaignName: name || "แคมเปญ Ppan", operationStatus: row.status,
      roiTargetTenths, budgetMinor, scheduleOpen, nativeAutoOff, fixedFingerprint, observedAt: at.toISOString(),
      fingerprint: hash([fixedFingerprint, row.modified, row.status, roiTargetTenths]) };
  }
  async function find(preferredPausedId?: string | null) {
    const key = await token(), campaigns = await list(key), active = campaigns.filter(c => c.status === "ENABLE");
    if (active.length > 1) throw new CampaignActionError("MULTIPLE_ACTIVE_CAMPAIGNS", 409, "มีหลายแคมเปญเปิดอยู่ จึงไม่เลือกแทนคุณ");
    const paused = campaigns.filter(c => c.status === "DISABLE");
    const row = active[0] ?? (preferredPausedId ? paused.find(c => c.campaignId === preferredPausedId) : undefined) ?? (paused.length === 1 ? paused[0] : undefined);
    return row ? snapshot(key, row) : null;
  }
  async function readExact(campaignId: string, key: string) {
    if (!hasId(campaignId)) return unavailable();
    const rows = await list(key, campaignId);
    return rows.length === 1 ? snapshot(key, rows[0]) : unavailable();
  }
  async function otherSpend(campaignId: string) {
    const key = await token(), day = bangkokDay(now()), seen = new Set<string>();
    let others = 0, count = 0, total: unknown, pages: unknown;
    for (let page = 1; page <= 3; page++) {
      const data = await get(SPEND, { service_type: "AUCTION", report_type: "TT_SHOP", data_level: "AUCTION_CAMPAIGN",
        dimensions: '["campaign_id","country_code","stat_time_day"]', metrics: '["spend"]', start_date: day, end_date: day, page, page_size: 1000 }, key);
      const p = object(data.page_info), n = p.total_number, m = p.total_page;
      if (!Array.isArray(data.list) || data.list.length > 1000 || p.page !== page || typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 ||
        typeof m !== "number" || !Number.isSafeInteger(m) || m < 0 || (m === 0 && data.list.length !== 0) || (m > 0 && m < page) ||
        (page > 1 && (n !== total || m !== pages)) || (data.advertiser_id !== undefined && data.advertiser_id !== binding.advertiserId)) return unavailable();
      total = n; pages = m;
      for (const item of data.list) {
        const row = object(item), d = object(row.dimensions);
        if (!hasId(d.campaign_id) || typeof d.stat_time_day !== "string" || d.stat_time_day.slice(0, 10) !== day || typeof d.country_code !== "string" ||
          (d.advertiser_id !== undefined && d.advertiser_id !== binding.advertiserId)) return unavailable();
        const k = JSON.stringify([d.campaign_id, d.stat_time_day, d.country_code]);
        if (seen.has(k)) return unavailable();
        seen.add(k); count++;
        const amount = minor(object(row.metrics).spend);
        if (d.campaign_id !== campaignId) others += amount;
        if (!Number.isSafeInteger(others)) return unavailable();
      }
      if (page >= m) break;
      if (page === 3) return unavailable();
    }
    // The provider reader does not consider an absent row a proof of zero spend.
    if (count !== total || !Array.from(seen).some(k => JSON.parse(k)[0] === campaignId) || day !== bangkokDay(now())) return unavailable();
    return others;
  }
  async function send(expected: CampaignActionSnapshot, action: CampaignAction, target: CampaignActionTarget, preflight: () => Promise<boolean>): Promise<CampaignActionOutcome> {
    let sent = false;
    try {
      const key = await token(), exact = await readExact(expected.campaignId, key);
      if (exact.fingerprint !== expected.fingerprint || !exact.scheduleOpen) return "NOT_SENT";
      const path = action === "SET_ROI" ? ROI : STATUS;
      let body: Data;
      if (action === "SET_ROI" && validRoiTenths(target.roiTenths) && target.roiTenths !== exact.roiTargetTenths && target.status === exact.operationStatus) {
        body = { advertiser_id: binding.advertiserId, campaign_id: exact.campaignId, roas_bid: target.roiTenths / 10 };
      } else if (((action === "PAUSE" && exact.operationStatus === "ENABLE" && target.status === "DISABLE") ||
        (action === "RESUME" && exact.operationStatus === "DISABLE" && target.status === "ENABLE" && exact.nativeAutoOff)) && target.roiTenths === exact.roiTargetTenths) {
        body = { advertiser_id: binding.advertiserId, campaign_ids: [exact.campaignId], operation_status: target.status };
      } else return "NOT_SENT";
      if (!await preflight()) return "NOT_SENT";
      sent = true;
      const response = await fetchImpl(HOST + path, { method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { "Access-Token": key, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await json(response);
      if (!response.ok || result.code !== 0) return "OUTCOME_UNKNOWN";
      if (path === STATUS) {
        const data = object(result.data);
        if (!Array.isArray(data.campaign_ids) || data.campaign_ids.length !== 1 || data.campaign_ids[0] !== exact.campaignId || data.status !== target.status) return "OUTCOME_UNKNOWN";
        if (data.campaign_list !== undefined && (!Array.isArray(data.campaign_list) || data.campaign_list.length !== 1 ||
          object(data.campaign_list[0]).campaign_id !== exact.campaignId || object(data.campaign_list[0]).status !== target.status)) return "OUTCOME_UNKNOWN";
      } else if (result.data != null) {
        const data = object(result.data);
        if ((data.campaign_id !== undefined && data.campaign_id !== exact.campaignId) ||
          (data.advertiser_id !== undefined && data.advertiser_id !== binding.advertiserId)) return "OUTCOME_UNKNOWN";
      }
      const first = await readExact(exact.campaignId, key), second = await readExact(exact.campaignId, key);
      const matches = (x: CampaignActionSnapshot) => x.fixedFingerprint === expected.fixedFingerprint && x.operationStatus === target.status && x.roiTargetTenths === target.roiTenths;
      return matches(first) && matches(second) && first.fingerprint === second.fingerprint ? "APPLIED_VERIFIED" : "OUTCOME_UNKNOWN";
    } catch { return sent ? "OUTCOME_UNKNOWN" : "NOT_SENT"; }
  }
  return { find, otherSpend, send };
}
