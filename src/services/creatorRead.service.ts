/** Ppan-only Creator pilot. No Shop IDs, OAuth, database writes, or ad mutations. */
export const CREATOR_BINDING = Object.freeze({
  advertiserId: "7666005333864644624", tiktokAccountId: "7285935731820920833",
  identityId: "9acd400c-e18e-5ad2-aed9-d3bac2e41d6a", identityType: "BC_AUTH_TT",
  identityAuthorizedBcId: "7627179356976201745",
});
export const CREATOR_APP_ID = "7667234745498992657";
const BASE = "https://business-api.tiktok.com/open_api/v1.3";
const ENDPOINTS = new Set(["/gmv_max/campaign/get/", "/campaign/gmv_max/info/", "/report/integrated/get/"]);
type Row = Record<string, any>;
export class CreatorReadError extends Error {
  constructor(readonly code: string) { super(code); }
}
export function minor(value: unknown): number {
  const input = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof input !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(input)) throw new CreatorReadError("MONEY_UNVERIFIED");
  const [whole, fraction = ""] = input.split(".");
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new CreatorReadError("MONEY_UNVERIFIED");
  return Number(result);
}
function accountId(value: unknown): value is string { return typeof value === "string" && /^[1-9]\d{5,30}$/.test(value); }
function clean(value: unknown, limit = 160): string | null {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, limit) : null;
}
// The verified without-Shop Creator campaign returns literal string "0" in
// top-level Shop fields. Zero is not a valid positive TikTok resource ID.
function noShop(value: unknown): boolean { return value == null || value === "" || value === "0"; }
export function bangkokDay(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (name: string) => parts.find(p => p.type === name)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
async function body(response: Response): Promise<Row> {
  if (Number(response.headers.get("content-length")) > 1_048_576) throw new CreatorReadError("RESPONSE_BOUNDARY");
  if (!response.body) throw new CreatorReadError("RESPONSE_UNAVAILABLE");
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 1_048_576) { await reader.cancel(); throw new CreatorReadError("RESPONSE_BOUNDARY"); }
      chunks.push(Buffer.from(chunk.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}
export interface CreatorReadDependencies {
  loadToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}
/** Cache is per-process, bounded to this one client and never persisted as financial truth. */
export function createCreatorReader({ loadToken, fetchImpl = fetch, now = () => new Date(), sleep = ms => new Promise(r => setTimeout(r, ms)) }: CreatorReadDependencies) {
  let cached: { at: number; value: Row } | undefined;
  let inFlight: Promise<Row> | undefined;
  async function read(): Promise<Row> {
    const started = now(), date = bangkokDay(started);
    const accessToken = await loadToken();
    if (typeof accessToken !== "string" || accessToken.length < 16) throw new CreatorReadError("CREDENTIAL_UNAVAILABLE");
    const deadline = Date.now() + 18_000;
    let calls = 0, lastStart = 0;
    async function get(endpoint: string, params: Row): Promise<Row> {
      if (!ENDPOINTS.has(endpoint) || ++calls > 10 || Date.now() >= deadline) throw new CreatorReadError("REQUEST_BOUNDARY");
      if (lastStart) await sleep(Math.max(0, 500 - (Date.now() - lastStart)));
      lastStart = Date.now();
      const url = new URL(BASE + endpoint);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      try {
        const response = await fetchImpl(url, { method: "GET", redirect: "error", headers: { "Access-Token": accessToken, Accept: "application/json" }, signal: AbortSignal.timeout(Math.max(1, Math.min(6000, deadline - Date.now()))) });
        const payload = await body(response);
        if (!response.ok || payload.code !== 0 || !payload.data || typeof payload.data !== "object") throw new CreatorReadError(payload.code === 40001 ? "CREATOR_PERMISSION_DENIED" : "CREATOR_READ_REJECTED");
        return payload.data;
      } catch (error) {
        if (error instanceof CreatorReadError) throw error;
        throw new CreatorReadError("CREATOR_UPSTREAM_UNAVAILABLE");
      }
    }
    const capabilities = { read: true, budgetWrite: false, create: false, pause: false, autoOptimization: false };
    const base: Row = { schemaVersion: 1, clientId: "punpan_020", source: "tiktok-creator-api", readOnly: true,
      reportingDate: date, timezone: "Asia/Bangkok", binding: CREATOR_BINDING, campaign: null, capabilities,
      nativeAutoBudgetState: "UNKNOWN", quality: { spendEstimated: true, spendSource: "TT_SHOP", reportLagSeconds: null,
        aggregateSpendComplete: false, aggregateSpendMinor: null, gmvAvailable: false, roiAvailable: false, liveViewsAvailable: false } };
    const campaigns: Row[] = [], seen = new Set<string>();
    let totalPages: number | undefined, expectedCount: number | undefined;
    for (let page = 1; page <= 5; page++) {
      const data = await get("/gmv_max/campaign/get/", { advertiser_id: CREATOR_BINDING.advertiserId,
        filtering: { gmv_max_promotion_types: ["LIVE_GMV_MAX"] },
        fields: ["advertiser_id", "campaign_id", "campaign_name", "operation_status"], page, page_size: 100 });
      const info = data.page_info;
      if (!Array.isArray(data.list) || data.list.length > 100 || info?.page !== page || !Number.isSafeInteger(info?.total_page)
        || info.total_page < 0 || (info.total_page === 0 && data.list.length > 0) || (info.total_page > 0 && info.total_page < page)
        || !Number.isSafeInteger(info.total_number) || info.total_number < 0
        || (totalPages !== undefined && totalPages !== info.total_page) || (expectedCount !== undefined && expectedCount !== info.total_number)) throw new CreatorReadError("CAMPAIGN_PAGINATION_UNVERIFIED");
      totalPages = info.total_page; expectedCount = info.total_number;
      for (const row of data.list) {
        if (!accountId(row?.campaign_id) || !["ENABLE", "DISABLE", "DELETE"].includes(row.operation_status)
          || (row.advertiser_id !== undefined && row.advertiser_id !== CREATOR_BINDING.advertiserId) || seen.has(row.campaign_id)) throw new CreatorReadError("CAMPAIGN_SCOPE_UNVERIFIED");
        seen.add(row.campaign_id); campaigns.push(row);
      }
      if (page >= totalPages!) break;
      if (page === 5) throw new CreatorReadError("CAMPAIGN_PAGE_LIMIT");
    }
    if (campaigns.length !== expectedCount) throw new CreatorReadError("CAMPAIGN_TOTAL_UNVERIFIED");
    const enabled = campaigns.filter(row => row.operation_status === "ENABLE");
    if (enabled.length > 1) throw new CreatorReadError("MULTIPLE_ENABLED_CAMPAIGNS_REVIEW_REQUIRED");
    if (!enabled.length) {
      if (bangkokDay(now()) !== date) throw new CreatorReadError("REPORTING_DAY_CHANGED_RETRY");
      return { ...base, observedAt: now().toISOString() };
    }
    const campaignId = enabled[0].campaign_id;
    const info = await get("/campaign/gmv_max/info/", { advertiser_id: CREATOR_BINDING.advertiserId, campaign_id: campaignId });
    if (info.campaign_id !== campaignId || info.advertiser_id !== CREATOR_BINDING.advertiserId || info.shopping_ads_type !== "LIVE" || info.operation_status !== "ENABLE"
      || !noShop(info.store_id) || !noShop(info.store_authorized_bc_id)
      || !Array.isArray(info.identity_list) || info.identity_list.length !== 1
      || info.identity_list[0].identity_id !== CREATOR_BINDING.identityId || info.identity_list[0].identity_type !== CREATOR_BINDING.identityType
      || info.identity_list[0].identity_authorized_bc_id !== CREATOR_BINDING.identityAuthorizedBcId
      || !noShop(info.identity_list[0].store_id) || !noShop(info.identity_list[0].identity_authorized_shop_id)) throw new CreatorReadError("CREATOR_IDENTITY_BINDING_UNVERIFIED");
    if (typeof info.roas_bid !== "number" || !Number.isFinite(info.roas_bid) || info.roas_bid <= 0) throw new CreatorReadError("ROI_TARGET_UNVERIFIED");
    const budget = minor(info.budget);
    if (budget <= 0) throw new CreatorReadError("BUDGET_UNVERIFIED");
    base.campaign = { campaignId, campaignName: clean(info.campaign_name)?.split(accessToken).join("[REDACTED]") ?? null, status: "ACTIVE", operationStatus: "ENABLE", currency: "THB",
      dailyBudgetMinor: budget, targetRoi: info.roas_bid, spendMinor: null, gmvMinor: null, roi: null, liveViews: null };
    const native = info.auto_budget?.auto_budget_enabled ?? info.auto_budget_enabled;
    base.nativeAutoBudgetState = native === true ? "ENABLED" : native === false ? "DISABLED" : "UNKNOWN";
    try {
      let aggregate = 0, target = 0, rowCount = 0, expectedRows: number | undefined, reportPages: number | undefined;
      const dimensions = new Set<string>();
      for (let page = 1; page <= 3; page++) {
        const data = await get("/report/integrated/get/", { advertiser_id: CREATOR_BINDING.advertiserId, service_type: "AUCTION", report_type: "TT_SHOP", data_level: "AUCTION_CAMPAIGN",
          dimensions: ["campaign_id", "country_code", "stat_time_day"], metrics: ["spend"], start_date: date, end_date: date, page, page_size: 1000 });
        const pagination = data.page_info;
        if (!Array.isArray(data.list) || data.list.length > 1000 || pagination?.page !== page || !Number.isSafeInteger(pagination.total_page)
          || !Number.isSafeInteger(pagination.total_number) || pagination.total_page < 0 || pagination.total_number < 0
          || (pagination.total_page === 0 && data.list.length > 0) || (pagination.total_page > 0 && pagination.total_page < page)
          || (reportPages !== undefined && reportPages !== pagination.total_page) || (expectedRows !== undefined && expectedRows !== pagination.total_number)) throw new CreatorReadError("SPEND_PAGINATION_UNVERIFIED");
        reportPages = pagination.total_page; expectedRows = pagination.total_number;
        for (const row of data.list) {
          const dim = row?.dimensions;
          if (!accountId(dim?.campaign_id) || typeof dim.stat_time_day !== "string" || dim.stat_time_day.slice(0, 10) !== date
            || typeof dim.country_code !== "string") throw new CreatorReadError("SPEND_SCOPE_UNVERIFIED");
          const key = JSON.stringify([dim.campaign_id, dim.country_code, dim.stat_time_day]);
          if (dimensions.has(key)) throw new CreatorReadError("SPEND_DUPLICATE_ROW");
          dimensions.add(key); rowCount++;
          const value = minor(row.metrics?.spend);
          aggregate += value;
          if (dim.campaign_id === campaignId) target += value;
          if (!Number.isSafeInteger(aggregate)) throw new CreatorReadError("SPEND_TOTAL_UNVERIFIED");
        }
        if (page >= reportPages!) break;
        if (page === 3) throw new CreatorReadError("SPEND_PAGE_LIMIT");
      }
      if (rowCount !== expectedRows) throw new CreatorReadError("SPEND_TOTAL_UNVERIFIED");
      // Absence of this campaign is not evidence of zero spend for the new Creator dialect.
      if (!Array.from(dimensions).some(key => JSON.parse(key)[0] === campaignId)) throw new CreatorReadError("TARGET_SPEND_UNAVAILABLE");
      base.campaign.spendMinor = target;
      base.quality.aggregateSpendMinor = aggregate;
      base.quality.aggregateSpendComplete = true;
    } catch (error) { base.quality.spendError = error instanceof CreatorReadError ? error.code : "SPEND_UNAVAILABLE"; }
    if (bangkokDay(now()) !== date) throw new CreatorReadError("REPORTING_DAY_CHANGED_RETRY");
    return { ...base, observedAt: now().toISOString() };
  }
  return async function snapshot(): Promise<Row> {
    if (cached && Date.now() - cached.at < 10_000 && cached.value.reportingDate === bangkokDay(now())) return cached.value;
    if (!inFlight) inFlight = read().then(value => { cached = { at: Date.now(), value }; return value; }).finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
