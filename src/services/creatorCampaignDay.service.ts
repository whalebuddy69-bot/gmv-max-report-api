import { bangkokDay, campaignSchedule, minor, type CreatorReadBinding, type CreatorReadDependencies } from "./creatorRead.service";

const BASE = "https://business-api.tiktok.com/open_api/v1.3";
const LIST = "/gmv_max/campaign/get/", REPORT = "/gmv_max/report/get/", INFO = "/campaign/gmv_max/info/", ADVERTISER = "/advertiser/info/";
const MAX_PAGES = 5, PAGE_SIZE = 100, MAX_CALLS = 40, BUDGET_MS = 24_000, TIMEOUT_MS = 6_000, MAX_BYTES = 1_048_576;
const CACHE_MS = 12_000, FAILURE_CACHE_MS = 12_000;
export const CREATOR_DAY_MAX_ROWS = 40;
const ID = /^[1-9]\d{5,30}$/;
type Status = "ENABLE" | "DISABLE" | "DELETE";
type Coverage = "complete" | "partial" | "unavailable";
type Data = Record<string, unknown>;
type DayMetrics = { spendMinor: number | null; gmvMinor: number | null; skuOrders: number | null; liveViews: number | null; activityToday: boolean };
export type CreatorCampaignDayRow = DayMetrics & {
  campaignId: string; campaignName: string; operationStatus: Status; dailyBudgetMinor: number | null;
  targetRoi: number | null; roi: number | null; scheduleStartAt: string | null; scheduleEndAt: string | null;
};
export type CreatorCampaignDay = {
  reportingDate: string; observedAt: string | null; coverage: Coverage; campaigns: CreatorCampaignDayRow[];
};

const isRecord = (v: unknown): v is Data => v !== null && typeof v === "object" && !Array.isArray(v);
const safeId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const status = (v: unknown): v is Status => v === "ENABLE" || v === "DISABLE" || v === "DELETE";
const absentShop = (v: unknown) => v == null || v === "" || v === "0";
const empty = (reportingDate: string): CreatorCampaignDay => ({ reportingDate, observedAt: null, coverage: "unavailable", campaigns: [] });
function unverified(): never { throw new Error("CREATOR_CAMPAIGN_DAY_UNVERIFIED"); }

async function json(response: Response): Promise<Data> {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_BYTES) unverified();
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const value = await reader.read();
      if (value.done) break;
      bytes += value.value.length;
      if (bytes > MAX_BYTES) { void reader.cancel().catch(() => undefined); unverified(); }
      chunks.push(Buffer.from(value.value));
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isRecord(result) || result.code !== 0 || !isRecord(result.data)) unverified();
    return result.data;
  } finally { reader.releaseLock(); }
}

function money(value: unknown): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && value.length > 24)) return null;
  try { return minor(value); } catch { return null; }
}
function count(value: unknown): number | null {
  const n = typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}
const campaignName = (name: unknown, token: string): string => typeof name === "string"
  ? name.split(token).join("[REDACTED]").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 160) : "";

/** Read-only today view. Request code provides neither campaign IDs nor advertiser identity. */
export function createCreatorCampaignDayReader({ loadToken, fetchImpl = fetch, now = () => new Date(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
}: CreatorReadDependencies, configured: CreatorReadBinding) {
  const binding = Object.freeze({ ...configured });
  let cached: { at: number; value: CreatorCampaignDay } | undefined;
  let inFlight: { day: string; promise: Promise<CreatorCampaignDay> } | undefined;

  async function read(day: string): Promise<CreatorCampaignDay> {
    const token = await loadToken();
    if (typeof token !== "string" || !/^[^\x00-\x20\x7f]{16,4096}$/.test(token)) unverified();
    const deadline = Date.now() + BUDGET_MS;
    let calls = 0, lastStart = 0;
    async function get(path: typeof LIST | typeof REPORT | typeof INFO | typeof ADVERTISER, params: Data): Promise<Data> {
      if (++calls > MAX_CALLS || Date.now() >= deadline) unverified();
      if (lastStart) await sleep(Math.max(0, 400 - (Date.now() - lastStart)));
      lastStart = Date.now();
      if (lastStart >= deadline) unverified();
      const url = new URL(BASE + path);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      const response = await fetchImpl(url, { method: "GET", redirect: "error",
        headers: { "Access-Token": token, Accept: "application/json", "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, deadline - lastStart)) });
      return json(response);
    }

    const metadata = await get(ADVERTISER, { advertiser_ids: [binding.advertiserId], fields: ["advertiser_id", "currency", "timezone"] });
    if (!Array.isArray(metadata.list) || metadata.list.length !== 1 || !isRecord(metadata.list[0]) ||
      metadata.list[0].advertiser_id !== binding.advertiserId || metadata.list[0].currency !== "THB" ||
      metadata.list[0].timezone !== "Asia/Bangkok") unverified();

    async function pages<T>(path: typeof LIST | typeof REPORT, params: Data, parse: (row: unknown) => { key: string; item: T }) {
      const items = new Map<string, T>();
      let totalPages: number | undefined, totalRows: number | undefined;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const data = await get(path, { advertiser_id: binding.advertiserId, ...params, page, page_size: PAGE_SIZE });
        const p = data.page_info;
        if (data.advertiser_id !== undefined && data.advertiser_id !== binding.advertiserId) unverified();
        if (!isRecord(p) || p.page !== page || (p.page_size !== undefined && p.page_size !== PAGE_SIZE) ||
          typeof p.total_page !== "number" || !Number.isSafeInteger(p.total_page) || p.total_page < 0 ||
          typeof p.total_number !== "number" || !Number.isSafeInteger(p.total_number) || p.total_number < 0 ||
          !Array.isArray(data.list) || data.list.length > PAGE_SIZE || (p.total_page > 0 && p.total_page < page) ||
          (p.total_page === 0 && data.list.length !== 0) || (page > 1 && (p.total_page !== totalPages || p.total_number !== totalRows))) unverified();
        totalPages = p.total_page; totalRows = p.total_number;
        for (const row of data.list) {
          const { key, item } = parse(row);
          if (items.has(key)) unverified();
          items.set(key, item);
        }
        if (page >= totalPages) {
          if (items.size !== totalRows) unverified();
          return { items, complete: true };
        }
      }
      return { items, complete: false };
    }

    const listed = await pages(LIST, { filtering: { gmv_max_promotion_types: ["LIVE_GMV_MAX"] },
      fields: ["advertiser_id", "campaign_id", "operation_status"] }, row => {
      if (!isRecord(row) || row.advertiser_id !== binding.advertiserId || !safeId(row.campaign_id) || !status(row.operation_status)) unverified();
      return { key: row.campaign_id, item: row.operation_status };
    }).catch(() => null);
    let metricsIncomplete = false;
    const reported = await pages(REPORT, { store_ids: ["0"], start_date: day, end_date: day, dimensions: ["campaign_id", "stat_time_day"],
      metrics: ["cost", "all_shops_gross_revenue", "all_shops_orders", "live_views"],
      filtering: { gmv_max_promotion_types: ["LIVE"], campaign_statuses: ["STATUS_ALL"] } }, row => {
      if (!isRecord(row) || !isRecord(row.dimensions) || !isRecord(row.metrics)) unverified();
      const d = row.dimensions;
      if (!safeId(d.campaign_id) || (d.stat_time_day !== day && d.stat_time_day !== `${day} 00:00:00`) ||
        (row.advertiser_id !== undefined && row.advertiser_id !== binding.advertiserId) ||
        (d.advertiser_id !== undefined && d.advertiser_id !== binding.advertiserId) ||
        (d.store_id !== undefined && d.store_id !== "0")) unverified();
      const spendMinor = money(row.metrics.cost), gmvMinor = money(row.metrics.all_shops_gross_revenue);
      const skuOrders = count(row.metrics.all_shops_orders), liveViews = count(row.metrics.live_views);
      const activityToday = [spendMinor, gmvMinor, skuOrders, liveViews].some(value => value !== null && value > 0);
      if (!activityToday && [spendMinor, gmvMinor, skuOrders, liveViews].some(value => value === null)) metricsIncomplete = true;
      return { key: d.campaign_id, item: { spendMinor, gmvMinor, skuOrders, liveViews, activityToday } };
    }).catch(() => null);

    if (!listed && !reported) return empty(day);
    let complete = listed?.complete === true && reported?.complete === true && !metricsIncomplete;
    const candidates = new Set<string>();
    for (const [id, operation] of listed?.items ?? []) if (operation === "ENABLE") candidates.add(id);
    for (const [id, metrics] of reported?.items ?? []) if (metrics.activityToday) candidates.add(id);
    if (candidates.size > CREATOR_DAY_MAX_ROWS) complete = false;
    const campaigns: CreatorCampaignDayRow[] = [];
    for (const id of [...candidates].slice(0, CREATOR_DAY_MAX_ROWS)) {
      try {
        const info = await get(INFO, { advertiser_id: binding.advertiserId, campaign_id: id });
        if (info.advertiser_id !== binding.advertiserId || info.campaign_id !== id || info.shopping_ads_type !== "LIVE" ||
          !status(info.operation_status) || !Array.isArray(info.identity_list) || info.identity_list.length !== 1 || !isRecord(info.identity_list[0])) unverified();
        const identity = info.identity_list[0];
        // Explicit Shop/foreign identity campaigns do not belong to this Creator and are never returned.
        if (safeId(info.store_id) || safeId(info.store_authorized_bc_id) || safeId(identity.store_id) || safeId(identity.identity_authorized_shop_id)) continue;
        if (typeof identity.identity_id === "string" && identity.identity_id.length >= 6 && identity.identity_id !== binding.identityId) continue;
        if (!absentShop(info.store_id) || !absentShop(info.store_authorized_bc_id) || !absentShop(identity.store_id) || !absentShop(identity.identity_authorized_shop_id) ||
          identity.identity_id !== binding.identityId || identity.identity_type !== binding.identityType ||
          identity.identity_authorized_bc_id !== binding.identityAuthorizedBcId ||
          (info.tiktok_account_id !== undefined && info.tiktok_account_id !== binding.tiktokAccountId)) unverified();
        const before = listed?.items.get(id);
        if (before !== undefined && before !== info.operation_status) complete = false;
        const metrics = reported?.items.get(id) ?? { spendMinor: null, gmvMinor: null, skuOrders: null, liveViews: null, activityToday: false };
        if (info.operation_status !== "ENABLE" && !metrics.activityToday) continue;
        const dailyBudgetMinor = money(info.budget), name = campaignName(info.campaign_name, token);
        campaigns.push({ campaignId: id, campaignName: name || "แคมเปญ Creator", operationStatus: info.operation_status,
          dailyBudgetMinor: dailyBudgetMinor && dailyBudgetMinor > 0 ? dailyBudgetMinor : null,
          targetRoi: typeof info.roas_bid === "number" && Number.isFinite(info.roas_bid) && info.roas_bid > 0 ? info.roas_bid : null,
          ...metrics,
          roi: metrics.spendMinor !== null && metrics.spendMinor > 0 && metrics.gmvMinor !== null ? metrics.gmvMinor / metrics.spendMinor : null,
          ...campaignSchedule(info) });
      } catch { complete = false; }
    }
    const observed = now();
    if (bangkokDay(observed) !== day) return empty(bangkokDay(observed));
    return { reportingDate: day, observedAt: observed.toISOString(), coverage: complete ? "complete" : "partial", campaigns };
  }

  return async function campaignDay(): Promise<CreatorCampaignDay> {
    const at = now(), reportingDate = bangkokDay(at);
    if (cached?.value.reportingDate === reportingDate && at.getTime() >= cached.at &&
      at.getTime() - cached.at < (cached.value.coverage === "unavailable" ? FAILURE_CACHE_MS : CACHE_MS)) return cached.value;
    if (inFlight) return inFlight.day === reportingDate ? inFlight.promise : empty(reportingDate);
    const promise = read(reportingDate).catch(() => empty(bangkokDay(now())))
      .then(value => { cached = { at: now().getTime(), value }; return value; }).finally(() => { inFlight = undefined; });
    inFlight = { day: reportingDate, promise };
    return promise;
  };
}
