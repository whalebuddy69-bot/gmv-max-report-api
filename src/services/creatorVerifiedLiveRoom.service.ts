import { bangkokDay, minor } from "./creatorRead.service";

const REPORT_URL = "https://business-api.tiktok.com/open_api/v1.3/gmv_max/report/get/";
const IDENTITY_LIVE_URL = "https://business-api.tiktok.com/open_api/v1.3/identity/live/get/";
const RESOURCE_ID = /^[1-9]\d{5,30}$/;
const BANGKOK_UTC_OFFSET_MS = 7 * 60 * 60 * 1_000;
const MAX_ONGOING_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_BODY_BYTES = 256 * 1024;
const TIMEOUT_MS = 5_000;
const PAGE_SIZE = 20;

type Row = Record<string, unknown>;
type RoomIdentity = Readonly<{ identityId: string; identityType: string; identityAuthorizedBcId: string }>;
export type CreatorVerifiedLiveRoomInput = Readonly<{
  advertiserId: string;
  campaignId: string;
  accessToken: string;
  reportingDate: string;
  expectedLiveSessionId?: string;
  autoDetectLive?: true;
}>;
export type CreatorVerifiedLiveRoom = Readonly<{
  liveDeliveryState: "LIVE" | "NOT_LIVE" | "UNKNOWN";
  liveSessionId: string | null;
  deliveryVerified: boolean;
  liveSessionStartedAt?: string;
  roomSpendMinor?: number;
  roomEvidenceIssue?: "STALE_ONGOING";
}>;

const UNKNOWN: CreatorVerifiedLiveRoom = Object.freeze({ liveDeliveryState: "UNKNOWN", liveSessionId: null, deliveryVerified: false });
const STALE_ONGOING: CreatorVerifiedLiveRoom = Object.freeze({ ...UNKNOWN, roomEvidenceIssue: "STALE_ONGOING" });
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

// The exact no-Shop Creator report has returned UTC-like launch values in
// production, despite the general GMV metric documentation. Only this new
// two-source path uses UTC; neither a timestamp nor ONGOING authorizes alone.
function utcLaunch(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const iso = value.replace(" ", "T") + ".000Z", at = Date.parse(iso);
  return Number.isFinite(at) && new Date(at).toISOString() === iso ? at : null;
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
  let expectedRoomEnded = false;
  for (const row of list) {
    if (!isRecord(row) || !isRecord(row.dimensions) || !isRecord(row.metrics) || !sameScope(row, input) ||
        !sameScope(row.dimensions, input) || !sameScope(row.metrics, input) || !sameDay(row.dimensions.stat_time_day, input.reportingDate)) return UNKNOWN;
    const roomId = row.dimensions.room_id;
    if (!validId(roomId) || seen.has(roomId) || input.accessToken.includes(roomId)) return UNKNOWN;
    seen.add(roomId);
    const status = row.metrics.live_status;
    if (status === "END") {
      if (roomId === input.expectedLiveSessionId) expectedRoomEnded = true;
      continue;
    }
    if (status !== "ONGOING" || ongoingRoom !== null) return UNKNOWN;
    const launched = bangkokLaunch(row.metrics.live_launched_time);
    if (launched === null || launched > observedAt.getTime()) return UNKNOWN;
    ongoingRoom = { id: roomId, launched };
  }
  if (ongoingRoom) return observedAt.getTime() - ongoingRoom.launched > MAX_ONGOING_AGE_MS ? STALE_ONGOING :
    Object.freeze({ liveDeliveryState: "LIVE", liveSessionId: ongoingRoom.id,
      liveSessionStartedAt: new Date(ongoingRoom.launched).toISOString(), deliveryVerified: true });
  // After a reporting-day rollover, an END-only page can contain another
  // room without saying anything about the already bound room.
  return input.expectedLiveSessionId === undefined || expectedRoomEnded ? NOT_LIVE : UNKNOWN;
}

type AutoCandidate = { id: string; launched: number; spend?: number };
function autoCandidate(payload: unknown, input: CreatorVerifiedLiveRoomInput, observedAt: Date): CreatorVerifiedLiveRoom | AutoCandidate {
  if (!isRecord(payload) || payload.code !== 0 || !isRecord(payload.data)) return UNKNOWN;
  const { list, page_info: page } = payload.data;
  if (!sameScope(payload.data, input) || !Array.isArray(list) || list.length < 1 || list.length > PAGE_SIZE || !isRecord(page) ||
      page.page !== 1 || page.page_size !== PAGE_SIZE || page.total_page !== 1 || page.total_number !== list.length) return UNKNOWN;
  const seen = new Set<string>();
  let ongoing: { id: string; metrics: Row } | null = null;
  let expectedEnded = false, ambiguousOngoing = false;
  for (const row of list) {
    if (!isRecord(row) || !isRecord(row.dimensions) || !isRecord(row.metrics) || !sameScope(row, input) || !sameScope(row.dimensions, input) ||
        !sameScope(row.metrics, input) || !sameDay(row.dimensions.stat_time_day, input.reportingDate)) return UNKNOWN;
    const id = row.dimensions.room_id, status = row.metrics.live_status;
    if (!validId(id) || seen.has(id) || input.accessToken.includes(id)) return UNKNOWN;
    seen.add(id);
    if (status === "END") { if (id === input.expectedLiveSessionId) expectedEnded = true; continue; }
    if (status !== "ONGOING") return UNKNOWN;
    if (ongoing) ambiguousOngoing = true;
    else ongoing = { id, metrics: row.metrics };
  }
  if (expectedEnded) return NOT_LIVE;
  if (!ongoing) return input.expectedLiveSessionId === undefined ? NOT_LIVE : UNKNOWN;
  if (ambiguousOngoing || (input.expectedLiveSessionId !== undefined && ongoing.id !== input.expectedLiveSessionId)) return UNKNOWN;
  const launched = utcLaunch(ongoing.metrics.live_launched_time);
  if (launched === null || launched <= 0 || launched > observedAt.getTime()) return UNKNOWN;
  const cost = ongoing.metrics.cost;
  let spend: number | undefined;
  if (cost !== undefined && cost !== null && cost !== "") {
    if (typeof cost !== "string") return UNKNOWN;
    try { spend = minor(cost); } catch { return UNKNOWN; }
  }
  if (observedAt.getTime() - launched > MAX_ONGOING_AGE_MS && !(spend !== undefined && spend > 0)) return STALE_ONGOING;
  return { id: ongoing.id, launched, ...(spend === undefined ? {} : { spend }) };
}

function identityCorroborates(payload: unknown, input: CreatorVerifiedLiveRoomInput, identity: RoomIdentity, id: string): boolean {
  if (!isRecord(payload) || payload.code !== 0 || !isRecord(payload.data)) return false;
  const scope = (row: Row) => exactWhenPresent(row.advertiser_id, input.advertiserId) && exactWhenPresent(row.identity_id, identity.identityId) &&
    exactWhenPresent(row.identity_type, identity.identityType) && exactWhenPresent(row.identity_authorized_bc_id, identity.identityAuthorizedBcId);
  const { live_list: list } = payload.data;
  if (!scope(payload.data) || !Array.isArray(list) || list.length > 100) return false;
  const exact = list.filter(x => isRecord(x) && x.live_id === id);
  const unfinished = list.filter(x => isRecord(x) && validId(x.live_id) && x.finish_timestamp === "1970-01-01 00:00:00");
  // Observed unset finish marker. It corroborates only a unique current-day
  // GMV ONGOING row from this exact campaign; it is never standalone evidence.
  return exact.length === 1 && unfinished.length === 1 && scope(exact[0]) && exact[0].finish_timestamp === "1970-01-01 00:00:00";
}

/** Reads exactly one provider room report after the caller verifies the enabled no-Shop Creator campaign and identity. */
export function createCreatorVerifiedLiveRoomReader({ advertiserId, identity, fetchImpl = fetch, now = () => new Date() }: {
  advertiserId: string;
  identity?: RoomIdentity;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): (input: CreatorVerifiedLiveRoomInput) => Promise<CreatorVerifiedLiveRoom> {
  return async input => {
    try {
      if (!validId(advertiserId) || !isRecord(input) || input.advertiserId !== advertiserId ||
          !validId(input.campaignId) || typeof input.accessToken !== "string" || !/^[^\x00-\x20\x7f]{16,4096}$/.test(input.accessToken) ||
          (input.expectedLiveSessionId !== undefined && !validId(input.expectedLiveSessionId)) ||
          (input.autoDetectLive !== undefined && input.autoDetectLive !== true) ||
          typeof input.reportingDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.reportingDate) ||
          bangkokDay(now()) !== input.reportingDate) return UNKNOWN;
      const fixed = Object.freeze({ ...input });
      const fixedIdentity = identity && Object.freeze({ ...identity });
      if (fixed.autoDetectLive === true && (!fixedIdentity || fixedIdentity.identityType !== "BC_AUTH_TT" ||
        typeof fixedIdentity.identityId !== "string" || !/^[A-Za-z0-9_-]{6,100}$/.test(fixedIdentity.identityId) ||
        !validId(fixedIdentity.identityAuthorizedBcId))) return UNKNOWN;
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
        const get = (target: URL) => fetchImpl(target, { method: "GET", redirect: "error", signal: controller.signal,
          headers: { "Access-Token": fixed.accessToken, Accept: "application/json", "Cache-Control": "no-cache" } }).then(boundedJson);
        const work = async (): Promise<CreatorVerifiedLiveRoom> => {
          const payload = await get(url), observedAt = now();
          if (controller.signal.aborted || bangkokDay(observedAt) !== fixed.reportingDate) return UNKNOWN;
          if (!fixed.autoDetectLive || !fixedIdentity) return classify(payload, fixed, observedAt);
          const next = autoCandidate(payload, fixed, observedAt);
          if (!("id" in next)) return next;
          const history = new URL(IDENTITY_LIVE_URL);
          const identityQuery = { advertiser_id: advertiserId, identity_id: fixedIdentity.identityId, identity_type: fixedIdentity.identityType,
            identity_authorized_bc_id: fixedIdentity.identityAuthorizedBcId, cursor: "0" };
          for (const [key, value] of Object.entries(identityQuery)) history.searchParams.set(key, value);
          const corroboration = await get(history);
          if (controller.signal.aborted || bangkokDay(now()) !== fixed.reportingDate || !identityCorroborates(corroboration, fixed, fixedIdentity, next.id)) {
            return observedAt.getTime() - next.launched > MAX_ONGOING_AGE_MS ? STALE_ONGOING : UNKNOWN;
          }
          return Object.freeze({ liveDeliveryState: "LIVE", liveSessionId: next.id, deliveryVerified: true,
            liveSessionStartedAt: new Date(next.launched).toISOString(), ...(next.spend === undefined ? {} : { roomSpendMinor: next.spend }) });
        };
        return await Promise.race([work(), timedOut]) ?? UNKNOWN;
      } finally { clearTimeout(timer); }
    } catch { return UNKNOWN; }
  };
}
