import { describe, expect, it, vi } from "vitest";
import { createCreatorVerifiedLiveRoomReader } from "./creatorVerifiedLiveRoom.service";

const ADVERTISERS = ["9123456789012345681", "9123456789012345682", "9123456789012345683"];
const ADVERTISER = ADVERTISERS[0];
const CAMPAIGN = "9123456789012345678";
const ROOM = "9123456789012345679";
const OTHER_ROOM = "9123456789012345680";
const TOKEN = "local-test-access-token";
const DAY = "2026-11-10";
const NOW = "2026-11-09T17:22:08.000Z";
const INPUT = { advertiserId: ADVERTISER, campaignId: CAMPAIGN, accessToken: TOKEN, reportingDate: DAY };
const UNKNOWN = { liveDeliveryState: "UNKNOWN", liveSessionId: null, deliveryVerified: false };
const ENDED = { liveDeliveryState: "NOT_LIVE", liveSessionId: null, deliveryVerified: true };
const LIVE = { liveDeliveryState: "LIVE", liveSessionId: ROOM, liveSessionStartedAt: "2026-11-09T16:58:15.000Z", deliveryVerified: true };
const IDENTITY = { identityId: "synthetic-room-identity", identityType: "BC_AUTH_TT", identityAuthorizedBcId: "9123456789012345684" };
const ONGOING_FINISH = "1970-01-01 00:00:00";
const AUTO_INPUT = { ...INPUT, autoDetectLive: true as const };

function row({ dimensions = {}, metrics = {}, outer = {} }: { dimensions?: Record<string, unknown>; metrics?: Record<string, unknown>;
  outer?: Record<string, unknown> } = {}) {
  return { dimensions: { room_id: ROOM, stat_time_day: `${DAY} 00:00:00`, ...dimensions },
    metrics: { live_status: "ONGOING", live_launched_time: "2026-11-09 23:58:15", live_duration: "", cost: "0.00", ...metrics }, ...outer };
}
function payload(rows: unknown[] = [row()], page = {}, outer = {}) {
  return { code: 0, data: { page_info: { page: 1, page_size: 20, total_page: rows.length ? 1 : 0, total_number: rows.length, ...page },
    list: rows, ...outer } };
}
function setup(body: unknown = payload(), opts: { advertiser?: string; now?: () => Date; response?: () => Promise<Response>;
  identity?: typeof IDENTITY; history?: unknown } = {}) {
  const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
    if (url.pathname.endsWith("/identity/live/get/")) {
      expect(url.origin).toBe("https://business-api.tiktok.com");
      expect(Object.fromEntries(url.searchParams)).toEqual({ advertiser_id: opts.advertiser ?? ADVERTISER, identity_id: IDENTITY.identityId,
        identity_type: IDENTITY.identityType, identity_authorized_bc_id: IDENTITY.identityAuthorizedBcId, cursor: "0" });
      expect(init.method).toBe("GET"); expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).get("Access-Token")).toBe(TOKEN);
      return Response.json(opts.history ?? { code: 0, data: { live_list: [{ live_id: ROOM, finish_timestamp: ONGOING_FINISH }] } });
    }
    expect(`${url.origin}${url.pathname}`).toBe("https://business-api.tiktok.com/open_api/v1.3/gmv_max/report/get/");
    expect(Object.fromEntries(url.searchParams)).toEqual({ advertiser_id: opts.advertiser ?? ADVERTISER, store_ids: '["0"]',
      start_date: DAY, end_date: DAY, dimensions: '["room_id","stat_time_day"]',
      metrics: '["live_status","live_launched_time","live_duration","cost"]', filtering: JSON.stringify({ campaign_ids: [CAMPAIGN] }),
      page: "1", page_size: "20" });
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init.headers).get("Access-Token")).toBe(TOKEN);
    expect(new Headers(init.headers).get("Cache-Control")).toBe("no-cache");
    return opts.response ? opts.response() : Response.json(body);
  });
  return { fetchImpl, read: createCreatorVerifiedLiveRoomReader({ advertiserId: opts.advertiser ?? ADVERTISER, identity: opts.identity, fetchImpl: fetchImpl as unknown as typeof fetch,
    now: opts.now ?? (() => new Date(NOW)) }) };
}

describe("two-source current Creator room Auto evidence", () => {
  const gm = (metrics = {}) => row({ metrics: { live_launched_time: "2026-11-09 16:58:15", cost: "3.45", ...metrics } });
  const history = (rows: unknown[]) => ({ code: 0, data: { live_list: rows } });
  const same = { live_id: ROOM, finish_timestamp: ONGOING_FINISH };
  it("accepts the unique current-day ongoing room only with its exact unfinished identity record and real cost", async () => {
    const h = setup(payload([gm()]), { identity: IDENTITY });
    await expect(h.read(AUTO_INPUT)).resolves.toEqual({ ...LIVE, roomSpendMinor: 345 });
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(h.fetchImpl.mock.calls[0][1].signal).toBe(h.fetchImpl.mock.calls[1][1].signal);
  });

  it("allows a >24h room only with exact same-day positive room cost and same-room identity corroboration", async () => {
    const old = "2026-11-08 14:00:00";
    await expect(setup(payload([gm({ live_launched_time: old })]), { identity: IDENTITY }).read(AUTO_INPUT)).resolves.toEqual({
      ...LIVE, liveSessionStartedAt: "2026-11-08T14:00:00.000Z", roomSpendMinor: 345 });
    const zero = setup(payload([gm({ live_launched_time: old, cost: "0.00" })]), { identity: IDENTITY });
    await expect(zero.read(AUTO_INPUT)).resolves.toEqual({ ...UNKNOWN, roomEvidenceIssue: "STALE_ONGOING" });
    expect(zero.fetchImpl).toHaveBeenCalledTimes(1);
    await expect(setup(payload([gm({ live_launched_time: old })]), { identity: IDENTITY, history: history([]) }).read(AUTO_INPUT))
      .resolves.toEqual({ ...UNKNOWN, roomEvidenceIssue: "STALE_ONGOING" });
  });

  it.each([history([]), history([same, same]), history([{ ...same, live_id: OTHER_ROOM }]), history([same, { ...same, live_id: OTHER_ROOM }]),
    history([{ ...same, finish_timestamp: "2026-11-09 16:58:30" }]),
    history([{ ...same, identity_id: "different-synthetic-identity" }]), { code: 40001 }])("rejects incomplete, finished or mismatched corroboration: %j", async h => {
    await expect(setup(payload([gm()]), { identity: IDENTITY, history: h }).read(AUTO_INPUT)).resolves.toEqual(UNKNOWN);
  });

  it.each([undefined, null, ""])("can corroborate a recent room without inventing current-day cost for %j", async cost => {
    const h = setup(payload([gm({ cost })]), { identity: IDENTITY });
    await expect(h.read(AUTO_INPUT)).resolves.toEqual(LIVE);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([0, "-1", "0.001"])("rejects malformed current-day room cost %j", async cost => {
    const h = setup(payload([gm({ cost })]), { identity: IDENTITY });
    await expect(h.read(AUTO_INPUT)).resolves.toEqual(UNKNOWN);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("holds a bound room when today's row is missing or another room appears; stops on exact current-day END", async () => {
    const bound = { ...AUTO_INPUT, expectedLiveSessionId: ROOM };
    const previous = row({ dimensions: { stat_time_day: "2026-11-09 00:00:00" }, metrics: { live_status: "END" } });
    const other = row({ dimensions: { room_id: OTHER_ROOM }, metrics: { live_status: "ONGOING", live_launched_time: "2026-11-09 16:58:15" } });
    const ended = gm({ live_status: "END", cost: undefined });
    for (const p of [payload([]), payload([previous]), payload([other])]) {
      const h = setup(p, { identity: IDENTITY });
      await expect(h.read(bound)).resolves.toEqual(UNKNOWN);
      expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    }
    const h = setup(payload([ended, other]), { identity: IDENTITY });
    await expect(h.read(bound)).resolves.toEqual(ENDED);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cannot use any auto-detected result without a pinned authorized identity", async () => {
    const h = setup(payload([gm()]));
    await expect(h.read(AUTO_INPUT)).resolves.toEqual(UNKNOWN);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("exact Creator LIVE-room evidence", () => {
  it.each(ADVERTISERS)("reads only the exact configured no-Shop campaign for %s", async advertiserId => {
    const h = setup(payload(), { advertiser: advertiserId });
    await expect(h.read({ ...INPUT, advertiserId })).resolves.toEqual(LIVE);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("converts a valid Bangkok launch at day rollover and does not require spend", async () => {
    // Interpreting the previous date 23:58 as UTC would be in the future.
    await expect(setup().read(INPUT)).resolves.toEqual(LIVE);
    await expect(setup().read({ ...INPUT, expectedLiveSessionId: ROOM })).resolves.toEqual(LIVE);
    await expect(setup(payload([row({ metrics: { live_launched_time: `${DAY} 00:22:00`, cost: "0.00" } })])).read(INPUT))
      .resolves.toEqual({ ...LIVE, liveSessionStartedAt: "2026-11-09T17:22:00.000Z" });
  });

  it("accepts exactly one active room alongside other clearly ended rooms", async () => {
    const ended = row({ dimensions: { room_id: OTHER_ROOM, stat_time_day: DAY }, metrics: { live_status: "END", live_launched_time: "" } });
    await expect(setup(payload([ended, row()])).read(INPUT)).resolves.toEqual(LIVE);
    await expect(setup(payload([ended])).read(INPUT)).resolves.toEqual(ENDED);
    await expect(setup(payload([])).read(INPUT)).resolves.toEqual(UNKNOWN);
  });

  it("only concludes that a bound room ended when today's report explicitly lists that room as END", async () => {
    const bound = { ...INPUT, expectedLiveSessionId: ROOM };
    const otherEnded = row({ dimensions: { room_id: OTHER_ROOM }, metrics: { live_status: "END", live_launched_time: "" } });
    const exactEnded = row({ metrics: { live_status: "END", live_launched_time: "" } });
    const oldExactEnded = row({ dimensions: { stat_time_day: "2026-11-09" }, metrics: { live_status: "END", live_launched_time: "" } });
    await expect(setup(payload([otherEnded])).read(bound)).resolves.toEqual(UNKNOWN);
    await expect(setup(payload([])).read(bound)).resolves.toEqual(UNKNOWN);
    await expect(setup(payload([otherEnded, exactEnded])).read(bound)).resolves.toEqual(ENDED);
    await expect(setup(payload([oldExactEnded])).read(bound)).resolves.toEqual(UNKNOWN);
    const otherLive = row({ dimensions: { room_id: OTHER_ROOM } });
    await expect(setup(payload([otherLive])).read(bound)).resolves.toEqual({ ...LIVE, liveSessionId: OTHER_ROOM });
    await expect(setup(payload([row(), otherLive])).read(bound)).resolves.toEqual(UNKNOWN);
  });

  it("surfaces the stale ongoing report without verifying it as LIVE", async () => {
    await expect(setup(payload([row({ metrics: { live_launched_time: "2026-11-09 00:22:07" } })])).read(INPUT))
      .resolves.toEqual({ ...UNKNOWN, roomEvidenceIssue: "STALE_ONGOING" });
  });

  it.each([null, "", "0", "2026-11-09T16:58:15Z", "2026-11-10 00:22:09", "2026-02-30 12:00:00",
    "2026-11-10 24:00:00", "2026-11-10 00:00:61"])("rejects an invalid, ambiguous, future or stale launch %j", async launch => {
    await expect(setup(payload([row({ metrics: { live_launched_time: launch } })])).read(INPUT)).resolves.toEqual(UNKNOWN);
  });

  it.each([
    [row(), row({ dimensions: { room_id: OTHER_ROOM } })],
    [row(), row({ metrics: { live_status: "END" } })],
    [row(), row({ dimensions: { room_id: OTHER_ROOM }, metrics: { live_status: "UNKNOWN" } })],
    [row({ dimensions: { room_id: "0" } })],
    [row({ dimensions: { room_id: Number(ROOM) } })],
    [row({ dimensions: { stat_time_day: "2026-11-09" } })],
    [row({ dimensions: { stat_time_day: `${DAY} 01:00:00` } })],
    [row({ dimensions: { advertiser_id: "9123456789012345689" } })],
    [row({ outer: { campaign_id: "9123456789012345689" } })],
    [row({ metrics: { store_id: "9123456789012345689" } })],
  ].map(rows => ({ rows })))("returns UNKNOWN for conflicting, malformed or mis-scoped room rows", async ({ rows }) => {
    await expect(setup(payload(rows)).read(INPUT)).resolves.toEqual(UNKNOWN);
  });

  it.each([{ total_number: 2 }, { total_page: 2 }, { page: 2 }, { page_size: 19 }, { total_page: "1" }])("does not trust incomplete or contradictory pagination: %j", async page => {
    await expect(setup(payload([row()], page)).read(INPUT)).resolves.toEqual(UNKNOWN);
  });

  it("rejects invalid request scope before issuing any GET", async () => {
    const h = setup();
    for (const input of [{ advertiserId: "9123456789012345677" }, { campaignId: "https://evil.invalid" },
      { accessToken: "invalid token" }, { reportingDate: "2026-11-09" }, { expectedLiveSessionId: "not-a-room-id" }]) {
      await expect(h.read({ ...INPUT, ...input })).resolves.toEqual(UNKNOWN);
    }
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed if the day changes while the provider request is in flight", async () => {
    const now = vi.fn().mockReturnValueOnce(new Date(NOW)).mockReturnValueOnce(new Date("2026-11-10T17:00:00.000Z"));
    await expect(setup(payload(), { now }).read(INPUT)).resolves.toEqual(UNKNOWN);
  });

  it("fails closed on provider errors, invalid JSON, or body above the fixed cap", async () => {
    for (const response of [new Response(null, { status: 429 }), new Response("not JSON"), new Response("x".repeat(256 * 1024 + 1)),
      Response.json({ code: 40001, message: TOKEN })]) {
      await expect(setup(null, { response: async () => response }).read(INPUT)).resolves.toEqual(UNKNOWN);
    }
  });

  it("bounds the entire request and aborts a hung fetch", async () => {
    vi.useFakeTimers();
    try {
      const h = setup(null, { response: () => new Promise(() => undefined) });
      const result = h.read(INPUT);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(result).resolves.toEqual(UNKNOWN);
      expect(h.fetchImpl.mock.calls[0][1].signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
