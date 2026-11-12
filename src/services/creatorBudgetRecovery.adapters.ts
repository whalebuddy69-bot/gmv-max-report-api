import { createHash } from "node:crypto";
import type { AutomationVerifiedCreatorBinding } from "./creatorAutomationRegistry.service";
import { configuredCreatorScheduledAutoLive } from "./creatorBudgetScope";
import { bangkokDay, minor } from "./creatorRead.service";
import { createCreatorWebBudgetAdapters } from "./creatorWebBudget.adapters";
import type { CreatorBudgetRecoveryEvidence } from "./creatorBudgetRecovery.store";

const FIXED = Object.freeze({ clientId: "bubpa_shop189", advertiserId: "7632368323640115207",
  tiktokAccountId: "7235929905719148546", identityId: "af94e7ff-cf71-5a99-8cf0-9d41b911d006",
  identityType: "BC_AUTH_TT" as const, identityAuthorizedBcId: "7627179356976201745" });
const ORIGIN = "https://business-api.tiktok.com", PREFIX = "/open_api/v1.3";
const INFO = "/campaign/gmv_max/info/", LIST = "/gmv_max/campaign/get/", ADVERTISER = "/advertiser/info/";
const REPORT = "/gmv_max/report/get/", LIVE = "/identity/live/get/";
const PATHS = new Set([INFO, LIST, ADVERTISER, REPORT, LIVE]);
const MAX_PAGES = 5, MAX_ENABLED_DETAILS = 3, MAX_REQUESTS = 24, MAX_BYTES = 1_048_576;
const DEADLINE_MS = 20_000, REQUEST_MS = 5_000;
const RESOURCE_ID = /^[1-9]\d{5,30}$/;
const ERROR = "BUBPA_RECOVERY_EVIDENCE_UNVERIFIED";
type Row = Record<string, unknown>;

const fail = (): never => { throw new Error(ERROR); };
const record = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && RESOURCE_ID.test(value);
const noShop = (value: unknown) => value == null || value === "" || value === "0";
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  return record(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)])) : value;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");
function stamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return false;
  const iso = value.replace(" ", "T") + ".000Z";
  return Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString() === iso;
}
function schedule(data: Row): { start: number; end: number | null; fixed: boolean } {
  const start = data.schedule_start_time, end = data.schedule_end_time;
  const fixed = data.schedule_type === "START_END" || data.schedule_type === "SCHEDULE_START_END";
  if ((!fixed && data.schedule_type !== "FROM_NOW" && data.schedule_type !== "SCHEDULE_FROM_NOW") || !stamp(start)
    || ((fixed || end != null) && !stamp(end))) return fail();
  const from = Date.parse(start.replace(" ", "T") + "Z"), to = stamp(end) ? Date.parse(end.replace(" ", "T") + "Z") : null;
  if (to !== null && to <= from) return fail();
  return { start: from, end: to, fixed };
}
function native(data: Row): "DISABLED" | "UNKNOWN" | "ENABLED" | "CONFLICT" {
  const auto = data.auto_budget == null ? {} : record(data.auto_budget) ? data.auto_budget : fail();
  const promotion = data.promotion_days == null ? {} : record(data.promotion_days) ? data.promotion_days : fail();
  const values = [data.auto_budget_enabled, auto.auto_budget_enabled, auto.is_enabled];
  if (values.some(v => v != null && v !== true && v !== false) || (promotion.is_enabled != null && typeof promotion.is_enabled !== "boolean")) return "CONFLICT";
  if (promotion.is_enabled === true) return "ENABLED";
  if (values.includes(true)) return values.includes(false) ? "CONFLICT" : "ENABLED";
  return values.includes(false) ? "DISABLED" : "UNKNOWN";
}
function exactInfo(data: Row, campaignId: string, binding: AutomationVerifiedCreatorBinding) {
  const identities = data.identity_list, identity = Array.isArray(identities) && identities.length === 1 ? identities[0] : null;
  if (data.advertiser_id !== binding.advertiserId || data.campaign_id !== campaignId || data.shopping_ads_type !== "LIVE"
    || data.store_id !== "0" || data.store_authorized_bc_id !== "0" || data.optimization_goal !== "VALUE" || data.deep_bid_type !== "VO_MIN_ROAS"
    || !record(identity) || identity.identity_id !== binding.identityId || identity.identity_type !== binding.identityType
    || identity.identity_authorized_bc_id !== binding.identityAuthorizedBcId || !noShop(identity.store_id) || !noShop(identity.identity_authorized_shop_id)
    || (data.tiktok_account_id !== undefined && data.tiktok_account_id !== binding.tiktokAccountId)
    || (identity.tiktok_account_id !== undefined && identity.tiktok_account_id !== binding.tiktokAccountId)
    || (identity.advertiser_id !== undefined && identity.advertiser_id !== binding.advertiserId)
    || typeof data.roas_bid !== "number" || !Number.isFinite(data.roas_bid) || data.roas_bid <= 0) return fail();
  const budgetMinor = minor(data.budget);
  if (budgetMinor <= 0) return fail();
  const times = schedule(data);
  const { budget: _, modify_time: _stamp, secondary_status: _delivery, ...settings } = data;
  const { roas_bid: _roi, ...nonRoi } = settings;
  return { budgetMinor, times, nativeAutoState: native(data), settingsFingerprint: hash(settings), nonRoiSettingsFingerprint: hash(nonRoi) };
}
async function bytes(response: Response): Promise<Uint8Array> {
  if (!response.body || Number(response.headers.get("content-length")) > MAX_BYTES) return fail();
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BYTES) { void reader.cancel().catch(() => undefined); return fail(); }
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks);
  } finally { reader.releaseLock(); }
}

/** GET-only, default-off evidence for a distinct-campaign quarantine; never an execution or repair API. */
export function createBubpaBudgetRecoveryEvidenceReader({ binding: configured, loadToken, fetchImpl = fetch, now = () => new Date(), env = process.env,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }: {
  binding: AutomationVerifiedCreatorBinding;
  loadToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
}): (oldCampaignId: string, newCampaignId: string) => Promise<CreatorBudgetRecoveryEvidence> {
  if (!configured || Object.entries(FIXED).some(([key, value]) => configured[key as keyof typeof FIXED] !== value)) return fail();
  const binding = Object.freeze({ ...FIXED });
  const flags = Object.fromEntries(["CREATOR_READ_ENABLED", "CREATOR_WEB_BUDGET_LIVE_ENABLED", "CREATOR_BUDGET_TEST_ENABLED",
    "CREATOR_WEB_BUBPA_SHOP189_BUDGET_MODE", "CREATOR_WEB_BUBPA_SHOP189_BUDGET_LIVE_ENABLED",
    "CREATOR_AUTO_BUDGET_BUBPA_SHOP189_MODE", "CREATOR_AUTO_BUDGET_BUBPA_SHOP189_LIVE_ENABLED"].map(k => [k, env[k]]));
  return async (oldCampaignId, newCampaignId) => {
    try {
      if (!id(oldCampaignId) || !id(newCampaignId) || oldCampaignId === newCampaignId || !configuredCreatorScheduledAutoLive(flags, binding.clientId)) return fail();
      const started = now().getTime(), realStarted = Date.now(), day = bangkokDay(new Date(started));
      if (!Number.isFinite(started)) return fail();
      const currentTime = () => {
        const at = now().getTime();
        if (!Number.isFinite(at) || at < started || at - started > DEADLINE_MS || Date.now() - realStarted > DEADLINE_MS || bangkokDay(new Date(at)) !== day) return fail();
        return at;
      };
      const token = await loadToken();
      if (typeof token !== "string" || !/^[^\x00-\x20\x7f]{16,4096}$/.test(token)) return fail();
      const permitted = new Set([oldCampaignId, newCampaignId]);
      let requests = 0, lastRequest: number | null = null, earliestRead: number | null = null;
      const getOnly: typeof fetch = async (input, init) => {
        currentTime();
        const url = new URL(String(input)), path = url.pathname.slice(PREFIX.length);
        if (++requests > MAX_REQUESTS || init?.method !== "GET" || init.body != null || url.origin !== ORIGIN || url.username || url.password || url.hash
          || !url.pathname.startsWith(PREFIX) || !PATHS.has(path)) return fail();
        if (path === ADVERTISER) {
          if (url.searchParams.get("advertiser_ids") !== JSON.stringify([binding.advertiserId])) return fail();
        } else if (url.searchParams.get("advertiser_id") !== binding.advertiserId) return fail();
        if (path === INFO && !permitted.has(url.searchParams.get("campaign_id") ?? "")) return fail();
        if (path === LIVE && (url.searchParams.get("identity_id") !== binding.identityId || url.searchParams.get("identity_type") !== binding.identityType
          || url.searchParams.get("identity_authorized_bc_id") !== binding.identityAuthorizedBcId)) return fail();
        if (path === REPORT && (url.searchParams.get("store_ids") !== '["0"]' || url.searchParams.get("filtering") !== JSON.stringify({ campaign_ids: [newCampaignId] }))) return fail();
        if (lastRequest !== null) await sleep(Math.max(0, 250 - (Date.now() - lastRequest)));
        const at = currentTime();
        earliestRead ??= at;
        lastRequest = Date.now();
        const controller = new AbortController();
        const inherited = init.signal, abort = () => controller.abort();
        inherited?.addEventListener("abort", abort, { once: true });
        if (inherited?.aborted) controller.abort();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error(ERROR)); }, Math.max(1, Math.min(REQUEST_MS, DEADLINE_MS - (Date.now() - realStarted))));
          });
          return await Promise.race([timeout, (async () => {
            const options: RequestInit & { cache: "no-store" } = { ...init, method: "GET", redirect: "error", cache: "no-store", signal: controller.signal,
              headers: { "Access-Token": token, Accept: "application/json", "Cache-Control": "no-cache" } };
            const response = await fetchImpl(url, options);
            const body = await bytes(response);
            currentTime();
            return new Response(body, { status: response.status, headers: { "Content-Type": "application/json" } });
          })()]);
        } finally { clearTimeout(timer); inherited?.removeEventListener("abort", abort); }
      };
      async function get(path: string, params: Record<string, unknown>): Promise<Row> {
        const url = new URL(ORIGIN + PREFIX + path);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
        const response = await getOnly(url, { method: "GET" });
        const payload: unknown = await response.json();
        if (!response.ok || !record(payload) || payload.code !== 0 || !record(payload.data)) return fail();
        return payload.data;
      }
      const info = (campaignId: string) => get(INFO, { advertiser_id: binding.advertiserId, campaign_id: campaignId });
      async function exactList(campaignId: string, status: "DISABLE" | "ENABLE") {
        const data = await get(LIST, { advertiser_id: binding.advertiserId,
          filtering: { gmv_max_promotion_types: ["LIVE_GMV_MAX"], campaign_ids: [campaignId] },
          fields: ["advertiser_id", "campaign_id", "operation_status", "modify_time"], page: 1, page_size: 100 });
        const row = Array.isArray(data.list) && data.list.length === 1 ? data.list[0] : null, page = data.page_info;
        if (!record(row) || !record(page) || page.page !== 1 || page.total_page !== 1 || page.total_number !== 1
          || row.advertiser_id !== binding.advertiserId || row.campaign_id !== campaignId || row.operation_status !== status || !stamp(row.modify_time)
          || (data.advertiser_id !== undefined && data.advertiser_id !== binding.advertiserId)) return fail();
        return row.modify_time;
      }
      const metadata = await get(ADVERTISER, { advertiser_ids: [binding.advertiserId], fields: ["advertiser_id", "currency", "timezone"] });
      const account = Array.isArray(metadata.list) && metadata.list.length === 1 ? metadata.list[0] : null;
      if (!record(account) || account.advertiser_id !== binding.advertiserId || account.currency !== "THB" || account.timezone !== "Asia/Bangkok"
        || (metadata.advertiser_id !== undefined && metadata.advertiser_id !== binding.advertiserId)) return fail();
      const old = await info(oldCampaignId), oldProof = exactInfo(old, oldCampaignId, binding);
      if (old.operation_status !== "DISABLE" || !["DISABLED", "UNKNOWN"].includes(oldProof.nativeAutoState)) return fail();
      const oldModifyTime = await exactList(oldCampaignId, "DISABLE");
      const seen = new Set<string>(), enabled: string[] = [];
      let expectedTotal: number | undefined, totalPages: number | undefined;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const data = await get(LIST, { advertiser_id: binding.advertiserId, filtering: { gmv_max_promotion_types: ["LIVE_GMV_MAX"] },
          fields: ["advertiser_id", "campaign_id", "operation_status"], page, page_size: 100 });
        const pagination = data.page_info;
        if (!Array.isArray(data.list) || data.list.length > 100 || !record(pagination) || pagination.page !== page
          || !Number.isSafeInteger(pagination.total_page) || Number(pagination.total_page) < 1 || Number(pagination.total_page) > MAX_PAGES
          || !Number.isSafeInteger(pagination.total_number) || Number(pagination.total_number) < 1 || Number(pagination.total_number) > MAX_PAGES * 100
          || (totalPages !== undefined && pagination.total_page !== totalPages) || (expectedTotal !== undefined && pagination.total_number !== expectedTotal)
          || (data.advertiser_id !== undefined && data.advertiser_id !== binding.advertiserId)) return fail();
        expectedTotal = Number(pagination.total_number); totalPages = Number(pagination.total_page);
        for (const row of data.list) {
          if (!record(row) || row.advertiser_id !== binding.advertiserId || !id(row.campaign_id) || seen.has(row.campaign_id)
            || !["ENABLE", "DISABLE", "DELETE"].includes(String(row.operation_status))) return fail();
          seen.add(row.campaign_id);
          if (row.operation_status === "ENABLE") enabled.push(row.campaign_id);
        }
        if (page >= totalPages) break;
      }
      if (seen.size !== expectedTotal || !enabled.includes(newCampaignId) || enabled.length > MAX_ENABLED_DETAILS) return fail();
      let newInfo: Row | undefined;
      const eligible: string[] = [];
      for (const campaignId of enabled) {
        permitted.add(campaignId);
        const data = await info(campaignId), proof = exactInfo(data, campaignId, binding);
        if (data.operation_status !== "ENABLE") return fail();
        // Ignore only a positively proven expired fixed schedule. Unknown schedules are never discarded.
        if (proof.times.fixed && proof.times.end !== null && proof.times.end <= currentTime()) continue;
        eligible.push(campaignId);
        if (campaignId === newCampaignId) newInfo = data;
      }
      if (eligible.length !== 1 || eligible[0] !== newCampaignId || !newInfo) return fail();
      const newProof = exactInfo(newInfo, newCampaignId, binding);
      if (newProof.times.end !== null && newProof.times.end <= currentTime() || !["DISABLED", "UNKNOWN"].includes(newProof.nativeAutoState)) return fail();
      const newModifyTime = await exactList(newCampaignId, "ENABLE");
      const adapters = createCreatorWebBudgetAdapters({ extraBinding: binding, loadToken: async () => token, fetchImpl: getOnly, now, env: flags });
      const newContext = await adapters.readAutoDetectContext?.(newCampaignId);
      if (!newContext || newContext.campaignId !== newCampaignId || newContext.reportingDate !== day
        || newContext.budgetMinor !== newProof.budgetMinor || newContext.settingsFingerprint !== newProof.settingsFingerprint
        || newContext.nonRoiSettingsFingerprint !== newProof.nonRoiSettingsFingerprint
        || newContext.fingerprint !== hash([newProof.budgetMinor, newModifyTime, newProof.settingsFingerprint])
        || !["DISABLED", "UNKNOWN"].includes(newContext.nativeAutoState)) return fail();
      const finalOld = await info(oldCampaignId), finalNew = await info(newCampaignId);
      if (finalOld.operation_status !== "DISABLE" || finalNew.operation_status !== "ENABLE"
        || hash(exactInfo(finalOld, oldCampaignId, binding)) !== hash(oldProof) || hash(exactInfo(finalNew, newCampaignId, binding)) !== hash(newProof)
        || await exactList(oldCampaignId, "DISABLE") !== oldModifyTime || await exactList(newCampaignId, "ENABLE") !== newModifyTime) return fail();
      const finishedAt = currentTime();
      if (earliestRead === null || finishedAt - earliestRead > DEADLINE_MS || finishedAt - Date.parse(newContext.observedAt) > DEADLINE_MS) return fail();
      return { clientId: binding.clientId, advertiserId: binding.advertiserId, identityFingerprint: hash(binding),
        observedAt: new Date(earliestRead).toISOString(), oldCampaignId, oldOperationStatus: "DISABLE", oldListOperationStatus: "DISABLE",
        oldBudgetMinor: oldProof.budgetMinor, newCampaignId, newOperationStatus: "ENABLE", newListOperationStatus: "ENABLE",
        soleEnabledCampaignId: newCampaignId, newBudgetMinor: newContext.budgetMinor, newFingerprint: newContext.fingerprint,
        newSettingsFingerprint: newContext.settingsFingerprint!, newNonRoiSettingsFingerprint: newContext.nonRoiSettingsFingerprint!,
        newScheduleStartAt: newContext.scheduleStartAt, newScheduleEndAt: newContext.scheduleEndAt, nativeAutoState: newContext.nativeAutoState as "DISABLED" | "UNKNOWN" };
    } catch { return fail(); }
  };
}
