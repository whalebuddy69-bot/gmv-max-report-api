import { bangkokDay, CREATOR_BINDING, minor } from "./creatorRead.service";

const REPORT_URL = "https://business-api.tiktok.com/open_api/v1.3/gmv_max/report/get/";
const PAGE_SIZE = 100;
const MAX_HOURS = 24;
const MAX_RESPONSE_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_MS = 180_000;
const FAILURE_CACHE_MS = 15_000;
const HOUR = /^(\d{4}-\d{2}-\d{2}) ((?:[01]\d|2[0-3]):00):00$/;
const CAMPAIGN_ID = /^[1-9]\d{5,30}$/;

export interface CreatorAutomationHour {
  /** TikTok's timezone-naive report bucket label, not a converted timestamp. */
  hour: string;
  spendMinor: number | null;
  gmvMinor: number | null;
  orders: number | null;
  roi: number | null;
  liveViews: number | null;
}

export interface CreatorAutomationPerformance {
  state: "available" | "unavailable";
  /** Time our server successfully received and validated TikTok's report, not report freshness. */
  observedAt: string | null;
  series: CreatorAutomationHour[];
}

export interface CreatorAutomationScope {
  /** Must come from the verified, active Creator snapshot, never a browser parameter. */
  campaignId: string;
  reportingDate: string;
}

interface Dependencies {
  loadToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const unavailable = (): CreatorAutomationPerformance => ({ state: "unavailable", observedAt: null, series: [] });
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function invalid(): never {
  // No provider body, request URL, account metadata or token in this error.
  throw new Error("CREATOR_AUTOMATION_PERFORMANCE_UNVERIFIED");
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) invalid();
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        invalid();
      }
      chunks.push(Buffer.from(chunk.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}

function optionalMoney(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.length > 20) invalid();
  return minor(value);
}

function optionalCount(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const count = typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : value;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) invalid();
  return count;
}

function optionalRatio(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const ratio = typeof value === "string" && /^\d{1,15}(?:\.\d{1,12})?$/.test(value) ? Number(value) : value;
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0 || ratio > Number.MAX_SAFE_INTEGER) invalid();
  return ratio;
}

function isActivity(row: CreatorAutomationHour): boolean {
  return [row.spendMinor, row.gmvMinor, row.orders, row.roi, row.liveViews].some(value => value !== null && value > 0);
}

function readSeries(payload: unknown, { campaignId, reportingDate }: CreatorAutomationScope): CreatorAutomationHour[] {
  if (!object(payload) || payload.code !== 0 || !object(payload.data)) invalid();
  const { list, page_info: page, advertiser_id: advertiser } = payload.data;
  if (!Array.isArray(list) || list.length > MAX_HOURS || !object(page) ||
    (advertiser !== undefined && advertiser !== CREATOR_BINDING.advertiserId) ||
    page.page !== 1 || page.total_number !== list.length ||
    (page.total_page !== 1 && !(list.length === 0 && page.total_page === 0)) ||
    (page.page_size !== undefined && page.page_size !== PAGE_SIZE)) invalid();
  // One campaign, one reporting date and hourly dimensions fit in one page.
  // Never expose a partial series when a different scope or pagination arrives.
  const seen = new Set<string>();
  const series = list.map((value: unknown): CreatorAutomationHour => {
    if (!object(value) || !object(value.dimensions) || !object(value.metrics)) invalid();
    const { dimensions, metrics } = value;
    const hour = typeof dimensions.stat_time_hour === "string" ? HOUR.exec(dimensions.stat_time_hour) : null;
    if (dimensions.campaign_id !== campaignId || !hour || hour[1] !== reportingDate || seen.has(hour[2]) ||
      (dimensions.advertiser_id !== undefined && dimensions.advertiser_id !== CREATOR_BINDING.advertiserId) ||
      (value.advertiser_id !== undefined && value.advertiser_id !== CREATOR_BINDING.advertiserId) ||
      (dimensions.store_id !== undefined && dimensions.store_id !== "0")) invalid();
    seen.add(hour[2]);
    const spendMinor = optionalMoney(metrics.cost);
    const roi = optionalRatio(metrics.all_shops_roi);
    return {
      hour: hour[2],
      spendMinor,
      gmvMinor: optionalMoney(metrics.all_shops_gross_revenue),
      orders: optionalCount(metrics.all_shops_orders),
      // A zero/unknown denominator cannot yield a meaningful ROI, even if TikTok supplies a zero placeholder.
      roi: spendMinor !== null && spendMinor > 0 ? roi : null,
      liveViews: optionalCount(metrics.live_views),
    };
  }).sort((a, b) => a.hour.localeCompare(b.hour));
  // TikTok may send all 24 buckets, including future zero padding. Without
  // verified hour timezone metadata, trim only after last positive activity.
  // No padding or inferred zero is added for hours absent from the response.
  let end = series.length;
  while (end > 0 && !isActivity(series[end - 1])) end--;
  return series.slice(0, end);
}

/** GET-only, verified no-Shop Creator reporting for the server's active Ppan campaign. */
export function createCreatorAutomationPerformance({
  loadToken,
  fetchImpl = fetch,
  now = () => new Date(),
}: Dependencies) {
  let cached: { key: string; at: number; value: CreatorAutomationPerformance } | undefined;
  let inFlight: { key: string; promise: Promise<CreatorAutomationPerformance> } | undefined;

  async function read(scope: CreatorAutomationScope): Promise<CreatorAutomationPerformance> {
    const accessToken = await loadToken();
    if (typeof accessToken !== "string" || !/^[^\x00-\x20\x7f]{16,4096}$/.test(accessToken)) invalid();
    const url = new URL(REPORT_URL);
    const params = {
      advertiser_id: CREATOR_BINDING.advertiserId,
      store_ids: ["0"],
      start_date: scope.reportingDate,
      end_date: scope.reportingDate,
      dimensions: ["campaign_id", "stat_time_hour"],
      metrics: ["cost", "all_shops_orders", "all_shops_gross_revenue", "all_shops_roi", "live_views"],
      filtering: {
        gmv_max_promotion_types: ["LIVE"],
        campaign_ids: [scope.campaignId],
        campaign_statuses: ["STATUS_ALL"],
      },
      page: 1,
      page_size: PAGE_SIZE,
    };
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: { "Access-Token": accessToken, Accept: "application/json", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const series = readSeries(await readJson(response), scope);
    const observed = now();
    if (bangkokDay(observed) !== scope.reportingDate) invalid();
    return { state: "available", observedAt: observed.toISOString(), series };
  }

  return async function performance(input: CreatorAutomationScope): Promise<CreatorAutomationPerformance> {
    // Copy and validate the two server-resolved values; never take advertiser,
    // stores, metric names, dates or pagination controls from browser input.
    const scope = { campaignId: input.campaignId, reportingDate: input.reportingDate };
    const currentTime = now();
    const at = currentTime.getTime();
    if (!Number.isFinite(at) || typeof scope.campaignId !== "string" || !CAMPAIGN_ID.test(scope.campaignId) ||
      scope.reportingDate !== bangkokDay(currentTime)) {
      return unavailable();
    }
    const key = `${scope.campaignId}/${scope.reportingDate}`;
    if (cached?.key === key && at >= cached.at &&
      at - cached.at < (cached.value.state === "available" ? CACHE_MS : FAILURE_CACHE_MS)) {
      return cached.value;
    }
    if (inFlight) return inFlight.key === key ? inFlight.promise : unavailable();
    const promise = read(scope)
      .catch(unavailable)
      .then(value => {
        cached = { key, at: now().getTime(), value };
        return value;
      })
      .finally(() => { inFlight = undefined; });
    inFlight = { key, promise };
    return promise;
  };
}
