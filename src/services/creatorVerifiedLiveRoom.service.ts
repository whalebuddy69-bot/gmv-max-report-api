import { bangkokDay } from "./creatorRead.service";

const REPORT_URL = "https://business-api.tiktok.com/open_api/v1.3/gmv_max/report/get/";
const RESOURCE_ID = /^[1-9]\d{5,30}$/;
const BANGKOK_UTC_OFFSET_MS = 7 * 60 * 60 * 1_000;
const MAX_ONGOING_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_BODY_BYTES = 256 * 1024;
const TIMEOUT_MS = 5_000;
const PAGE_SIZE = 20;

type Row = Record<string, unknown>;
export type CreatorVerifiedLiveRoomInput = Readonly<{
  advertiserId: string;
  campaignId: string;
  accessToken: string;
  reportingDate: string;
}>;
export type CreatorVerifiedLiveRoom = Readonly<{
  liveDeliveryState: "LIVE" | "NOT_LIVE" | "UNKNOWN";
  liveSessionId: string | null;
  deliveryVerified: boolean;
  liveSessionStartedAt?: string;
}>;

const UNKNOWN: CreatorVerifiedLiveRoom = Object.freeze({ liveDeliveryState: "UNKNOWN", liveSessionId: null, deliveryVerified: false });
const NOT_LIVE: CreatorVerifiedLiveRoom = Object.freeze({ liveDeliveryState: "NOT_LIVE", liveSessionId: null, deliveryVerified: true });
const isRecord = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === "string" && RESOURCE_ID.test(value);
const exactWhenPresent = (value: unknown, expected: string) => value === undefined || value === expected;
const sameDay = (value: unknown, expected: string) => value === expected || value === `${expected} 00:00:00`;

function sameScope(row: Row, { advertiserId, campaignId }: CreatorVerifiedLiveRoomInput): boolean {
  return exactWhenPresent(row.advertiser_id, advertiserId) && exactWhenPresent(row.campaign_id, campaignId) &&
    exactWhenPresent(row.store_id, "0") && exactWhenPresent(row.store_authorized_bc_id, "0") &&
    (row.store_ids === undefined || (Array.isArray(row.store_ids) && row.store_ids.length === 1 && row.store_ids[0] === "0"));
}

// TikTok's GMV Max metric docs specify the ad account timezone for this field,
// unlike campaign schedule timestamps (UTC). These scoped advertisers are
// independently verified as Asia/Bangkok; normalize to an unambiguous instant.
function bangkokLaunch(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const epoch = Date.parse(`${value.replace(" ", "T")}+07:00`);
  return Number.isFinite(epoch) && new Date(epoch + BANGKOK_UTC_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ") === value
    ? epoch : null;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_BODY_BYTES) return null;
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) { void reader.cancel().catch(() => undefined); return null; }
      chunks.push(Buffer.from(chunk.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}

function classify(payload: unknown, input: CreatorVerifiedLiveRoomInput, observedAt: Date): CreatorVerifiedLiveRoom {
  if (!isRecord(payload) || payload.code !== 0 || !isRecord(payload.data)) return UNKNOWN;
  const { list, page_info: page } = payload.data;
  if (!sameScope(payload.data, input) || !Array.isArray(list) || list.length < 1 || list.length > PAGE_SIZE || !isRecord(page) ||
      page.page !== 1 || page.page_size !== PAGE_SIZE || page.total_page !== 1 || page.total_number !== list.length) return UNKNOWN;
  const seen = new Set<string>();
  let ongoingRoom: { id: string; launched: number } | null = null;
  for (const row of list) {
    if (!isRecord(row) || !isRecord(row.dimensions) || !isRecord(row.metrics) || !sameScope(row, input) ||
        !sameScope(row.dimensions, input) || !sameScope(row.metrics, input) || !sameDay(row.dimensions.stat_time_day, input.reportingDate)) return UNKNOWN;
    const roomId = row.dimensions.room_id;
    if (!validId(roomId) || seen.has(roomId) || input.accessToken.includes(roomId)) return UNKNOWN;
    seen.add(roomId);
    const status = row.metrics.live_status;
    if (status === "END") continue;
    if (status !== "ONGOING" || ongoingRoom !== null) return UNKNOWN;
    const launched = bangkokLaunch(row.metrics.live_launched_time);
    if (launched === null || launched > observedAt.getTime() || observedAt.getTime() - launched > MAX_ONGOING_AGE_MS) return UNKNOWN;
    ongoingRoom = { id: roomId, launched };
  }
  return ongoingRoom === null ? NOT_LIVE : Object.freeze({ liveDeliveryState: "LIVE", liveSessionId: ongoingRoom.id,
    liveSessionStartedAt: new Date(ongoingRoom.launched).toISOString(), deliveryVerified: true });
}

/** Reads exactly one provider room report after the caller verifies the enabled no-Shop Creator campaign and identity. */
export function createCreatorVerifiedLiveRoomReader({ advertiserId, fetchImpl = fetch, now = () => new Date() }: {
  advertiserId: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): (input: CreatorVerifiedLiveRoomInput) => Promise<CreatorVerifiedLiveRoom> {
  return async input => {
    try {
      if (!validId(advertiserId) || !isRecord(input) || input.advertiserId !== advertiserId ||
          !validId(input.campaignId) || typeof input.accessToken !== "string" || !/^[^\x00-\x20\x7f]{16,4096}$/.test(input.accessToken) ||
          typeof input.reportingDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.reportingDate) ||
          bangkokDay(now()) !== input.reportingDate) return UNKNOWN;
      const fixed = Object.freeze({ ...input });
      const url = new URL(REPORT_URL);
      const query = { advertiser_id: fixed.advertiserId, store_ids: ["0"], start_date: fixed.reportingDate, end_date: fixed.reportingDate,
        dimensions: ["room_id", "stat_time_day"], metrics: ["live_status", "live_launched_time", "live_duration", "cost"],
        filtering: { campaign_ids: [fixed.campaignId] }, page: "1", page_size: String(PAGE_SIZE) };
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));

      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<null>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, TIMEOUT_MS);
      });
      try {
        const payload = await Promise.race([fetchImpl(url, { method: "GET", redirect: "error", signal: controller.signal,
          headers: { "Access-Token": fixed.accessToken, Accept: "application/json", "Cache-Control": "no-cache" } }).then(boundedJson), timedOut]);
        const observedAt = now();
        return !controller.signal.aborted && bangkokDay(observedAt) === fixed.reportingDate ? classify(payload, fixed, observedAt) : UNKNOWN;
      } finally { clearTimeout(timer); }
    } catch { return UNKNOWN; }
  };
}
