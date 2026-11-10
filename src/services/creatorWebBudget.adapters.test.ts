import { describe, expect, it } from "vitest";
import { CREATOR_BINDING } from "./creatorRead.service";
import { createCreatorWebBudgetAdapters, createCreatorWebCapAdapters } from "./creatorWebBudget.adapters";
import type { WebBudgetSource } from "./creatorWebBudget.service";
import { configuredCreatorAutoBudgetMode, configuredCreatorWebBudgetMode, configuredPpanSpendTrendLive, creatorBudgetPolicyPath,
  LIVE_ROOM_SPEND_TREND, type CreatorBudgetScope } from "./creatorBudgetScope";

const NOW = "2025-03-15T09:00:00.000Z", TODAY = "2025-03-15", CAMPAIGN = "1234567890123456";
const OTHER_CAMPAIGN = "1234567890123457", MISSING_CAMPAIGN = "1234567890123458";
const ROOM = "1234567890123459";
const OP = "5035df00-1801-4d02-8051-01affbbefdc9", KEY = "p".repeat(43), TOKEN = "synthetic-tiktok-adapter-key";
const LEASE_END = "2025-03-15T09:00:55.000Z";
const policy = { schemaVersion: 1, clientId: "punpan_020", revision: 4, campaignCapMinor: 600_000,
  clientDailyCapMinor: 700_000, readAt: NOW, locked: false };
const SRIHIW = { clientId: "srihiw", advertiserId: "1234567890198765", tiktokAccountId: "1234567890198766",
  identityId: "synthetic-srihiw-identity", identityType: "BC_AUTH_TT" as const, identityAuthorizedBcId: "1234567890198767" };
const dailyRow = (campaignId: string, cost: unknown = "0.00", dimensions = {}) => ({
  dimensions: { campaign_id: campaignId, stat_time_day: `${TODAY} 00:00:00`, store_id: "0", ...dimensions }, metrics: { cost },
});
const pageInfo = (count: number, page = 1, pages = 1) => ({ page, total_page: pages, total_number: count });
const SCHEDULED_SCOPES = [["punpan_020", {}], ["srihiw", { extra: true }], ["nnshop5719", { extraClient: "nnshop5719" }],
  ["ashopbytheta", { extraClient: "ashopbytheta" }], ["myushop4", { extraClient: "myushop4" }],
  ["bubpa_shop189", { extraClient: "bubpa_shop189" }], ["koolkool888", { extraClient: "koolkool888" }]] as const;

function harness(options: { mode?: string; competing?: boolean; nativeUnknown?: boolean; spendTrend?: boolean; sriTrend?: boolean; legacy?: boolean; policyKey?: string;
  providerResult?: "unknown" | "reject" | "roi-drift" | "reject-with-drift"; readAt?: string;
  extra?: boolean; extraLive?: boolean; extraClient?: "nnshop5719" | "ashopbytheta" | "myushop4" | "bubpa_shop189" | "koolkool888"; wrongProviderScope?: boolean;
  targetAbsent?: boolean; integrated?: Record<string, unknown>; daily?: (page: number) => unknown; currency?: string;
  campaignInfo?: Record<string, unknown>; campaignList?: Record<string, unknown>; listedStatus?: string; secondaryStatus?: unknown; timezone?: string;
  scheduledLive?: boolean; room?: "ONGOING" | "END"; detectRoom?: boolean; roomCost?: string | null;
  identityLive?: "ongoing" | "ended" | "missing"; now?: () => Date } = {}) {
  const calls: { host: string; path: string; method: string }[] = [];
  const queries: { path: string; query: Record<string, string> }[] = [];
  const extra = options.extraClient ? { ...SRIHIW, clientId: options.extraClient,
    advertiserId: options.extraClient === "nnshop5719" ? "1234567890198768" : "1234567890198769",
    identityId: `synthetic-${options.extraClient}-identity` } : options.extra ? SRIHIW : undefined;
  const binding = extra ?? CREATOR_BINDING;
  const scheduledEnv = !options.scheduledLive ? {} : extra ? { CREATOR_AUTO_BUDGET_LIVE_ENABLED: "true",
    [`CREATOR_AUTO_BUDGET_${extra.clientId.toUpperCase()}_MODE`]: "live", [`CREATOR_AUTO_BUDGET_${extra.clientId.toUpperCase()}_LIVE_ENABLED`]: "true" } :
    { CREATOR_AUTO_BUDGET_LIVE_ENABLED: "true", CREATOR_AUTO_BUDGET_MODE: "live", CREATOR_AUTO_BUDGET_PPAN_CONTINUOUS_LIVE_ENABLED: "true" };
  let budget = 2800, roi = 15, stamp = "2025-03-15 08:55:00", spend = "2100.09", otherSpend = "20.00", secondaryStatus = options.secondaryStatus;
  let detailSecondaryStatus: unknown;
  let daily = options.daily ?? (() => ({ page_info: pageInfo(2), list: [dailyRow(CAMPAIGN), dailyRow(MISSING_CAMPAIGN, 0)] }));
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({ host: url.host, path: url.pathname, method });
    queries.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    expect(init?.redirect).toBe("error");
    if (url.host === "whale-buddy-ads-control-plane.onrender.com") {
      expect(headers.get("x-creator-web-key")).toBe(KEY);
      expect(headers.get("access-token")).toBeNull();
      expect(url.pathname).toContain(extra ? `/${extra.clientId}/policy` : "/ppan/policy");
      const reply = { ...policy, ...(extra ? { clientId: extra.clientId, configured: true } : {}), readAt: options.readAt ?? NOW };
      if (url.pathname.endsWith("/lease")) {
        expect(JSON.parse(String(init?.body))).toEqual({ operationId: OP, revision: 4 });
        return Response.json({ ...reply, locked: true, operationId: OP, expiresAt: LEASE_END });
      }
      if (url.pathname.endsWith("/finish")) {
        expect(JSON.parse(String(init?.body))).toEqual({ operationId: OP, outcome: "NOT_SENT" });
        return Response.json({ schemaVersion: 1, operationId: OP, outcome: "NOT_SENT", locked: false });
      }
      expect(method).toBe("GET");
      return Response.json(reply);
    }
    expect(url.host).toBe("business-api.tiktok.com");
    expect(headers.get("access-token")).toBe(TOKEN);
    expect(headers.get("x-creator-web-key")).toBeNull();
    if (method === "POST") {
      expect(url.pathname).toBe("/open_api/v1.3/campaign/gmv_max/update/");
      const body = JSON.parse(String(init?.body));
      expect(Object.keys(body).sort()).toEqual(["advertiser_id", "budget", "campaign_id"]);
      expect(body.advertiser_id).toBe(binding.advertiserId);
      expect(body.campaign_id).toBe(CAMPAIGN);
      if (options.providerResult === "unknown") throw new Error("synthetic socket close");
      if (options.providerResult === "reject") return Response.json({ code: 123 });
      budget = body.budget;
      stamp = "2025-03-15 09:00:00";
      if (options.providerResult === "roi-drift") roi++;
      if (options.providerResult === "reject-with-drift") return Response.json({ code: 123 });
      return Response.json({ code: 0, data: { campaign_id: CAMPAIGN } });
    }
    if (url.pathname.endsWith("/advertiser/info/")) return Response.json({ code: 0, data: { list: [{ advertiser_id: binding.advertiserId,
      timezone: options.timezone ?? "Asia/Bangkok", currency: options.currency ?? "THB" }] } });
    expect(url.searchParams.get("advertiser_id")).toBe(binding.advertiserId);
    if (url.pathname.endsWith("/identity/live/get/")) {
      expect(method).toBe("GET");
      expect(options.detectRoom).toBe(true);
      expect(Object.fromEntries(url.searchParams)).toEqual({ advertiser_id: binding.advertiserId, identity_id: binding.identityId,
        identity_type: binding.identityType, identity_authorized_bc_id: binding.identityAuthorizedBcId, cursor: "0" });
      return Response.json({ code: 0, data: { live_list: options.identityLive === "missing" ? [] : [{ live_id: ROOM,
        finish_timestamp: options.identityLive === "ended" ? `${TODAY} 09:00:00` : "1970-01-01 00:00:00" }] } });
    }
    if (url.pathname.endsWith("/gmv_max/campaign/get/")) return Response.json({ code: 0, data: {
      page_info: { page: 1, total_page: 1, total_number: 1 }, list: [{ campaign_id: CAMPAIGN,
        advertiser_id: options.wrongProviderScope ? CREATOR_BINDING.advertiserId : binding.advertiserId, operation_status: options.listedStatus ?? "ENABLE", modify_time: stamp,
        ...(secondaryStatus === undefined ? {} : { secondary_status: secondaryStatus }) }],
      ...options.campaignList } });
    if (url.pathname.endsWith("/campaign/gmv_max/info/")) return Response.json({ code: 0, data: {
      advertiser_id: binding.advertiserId, campaign_id: CAMPAIGN, campaign_name: "Fixture LIVE", shopping_ads_type: "LIVE",
      store_id: "0", store_authorized_bc_id: "0", operation_status: "ENABLE", budget, roas_bid: roi,
      optimization_goal: "VALUE", deep_bid_type: "VO_MIN_ROAS", schedule_type: "SCHEDULE_FROM_NOW",
      schedule_start_time: "2025-03-15 08:30:00", ...(options.nativeUnknown ? {} : { auto_budget_enabled: options.competing === true }),
      ...(detailSecondaryStatus === undefined ? {} : { secondary_status: detailSecondaryStatus }), promotion_days: { is_enabled: false }, identity_list: [{ identity_id: binding.identityId,
        identity_type: binding.identityType, identity_authorized_bc_id: binding.identityAuthorizedBcId }], ...options.campaignInfo } });
    if (url.pathname.endsWith("/gmv_max/report/get/")) {
      expect(method).toBe("GET");
      expect(headers.get("Cache-Control")).toBe("no-cache");
      expect(url.searchParams.get("store_ids")).toBe('["0"]');
      expect(url.searchParams.get("start_date")).toBe(TODAY);
      expect(url.searchParams.get("end_date")).toBe(TODAY);
      if (url.searchParams.get("dimensions") === '["room_id","stat_time_day"]') {
        expect(url.searchParams.get("filtering")).toBe(JSON.stringify({ campaign_ids: [CAMPAIGN] }));
        const list = options.room ? [{ dimensions: { room_id: ROOM, stat_time_day: `${TODAY} 00:00:00` },
          metrics: { live_status: options.room, live_launched_time: `${TODAY} ${options.detectRoom ? "08:55:00" : "15:55:00"}`,
            live_duration: "", cost: options.detectRoom ? options.roomCost : "0.00" } }] : [];
        return Response.json({ code: 0, data: { list, page_info: { ...pageInfo(list.length, 1, list.length ? 1 : 0), page_size: 20 } } });
      }
      expect(url.searchParams.get("filtering")).toBe('{"gmv_max_promotion_types":["LIVE"],"campaign_statuses":["STATUS_ALL"]}');
      return Response.json({ code: 0, data: daily(Number(url.searchParams.get("page"))) });
    }
    expect(url.pathname).toBe("/open_api/v1.3/report/integrated/get/");
    const list = [
      ...(options.targetAbsent ? [] : [{ dimensions: { campaign_id: CAMPAIGN, country_code: "TH", stat_time_day: TODAY }, metrics: { spend } }]),
      { dimensions: { campaign_id: OTHER_CAMPAIGN, country_code: "TH", stat_time_day: TODAY }, metrics: { spend: otherSpend } },
    ];
    return Response.json({ code: 0, data: { page_info: pageInfo(list.length), list, ...options.integrated } });
  }) as typeof fetch;
  const adapters = createCreatorWebBudgetAdapters({ loadToken: async () => TOKEN, fetchImpl, now: options.now ?? (() => new Date(NOW)), sleep: async () => {},
    extraBinding: extra,
    env: { CREATOR_READ_ENABLED: "true", CREATOR_WEB_BUDGET_MODE: options.mode ?? "live", CREATOR_WEB_BUDGET_LIVE_ENABLED: "true",
      CREATOR_AUTO_BUDGET_PPAN_SPEND_TREND_LIVE_ENABLED: options.spendTrend ? "true" : "false",
      CREATOR_AUTO_BUDGET_SRIHIW_SPEND_TREND_LIVE_ENABLED: options.sriTrend ? "true" : "false",
      CREATOR_WEB_SRIHIW_BUDGET_MODE: options.mode ?? "live", CREATOR_WEB_SRIHIW_BUDGET_LIVE_ENABLED: options.extraLive ? "true" : "false",
      ...(options.extraClient ? { [`CREATOR_WEB_${options.extraClient.toUpperCase()}_BUDGET_MODE`]: options.mode ?? "live",
        [`CREATOR_WEB_${options.extraClient.toUpperCase()}_BUDGET_LIVE_ENABLED`]: options.extraLive ? "true" : "false" } : {}),
      CREATOR_BUDGET_TEST_ENABLED: options.legacy ? "true" : "false", CREATOR_WEB_POLICY_BRIDGE_KEY: options.policyKey ?? KEY, ...scheduledEnv } });
  return { adapters, calls, queries, edit(value: number) { budget = value; stamp = "2025-03-15 08:59:30"; }, setSpend(value: string) { spend = value; },
    setRoi(value: number) { roi = value; }, setDetailSecondaryStatus(value: unknown) { detailSecondaryStatus = value; },
    setOtherSpend(value: string) { otherSpend = value; }, setDaily(value: typeof daily) { daily = value; }, setSecondaryStatus(value: unknown) { secondaryStatus = value; },
    async input(targetBudgetMinor = 310_000, source?: WebBudgetSource) {
      const ctx = await adapters.readContext(CAMPAIGN, source);
      return { campaignId: CAMPAIGN, reportingDate: TODAY, expectedBudgetMinor: ctx.budgetMinor, targetBudgetMinor,
        fingerprint: ctx.fingerprint, notAfter: LEASE_END, campaignCapMinor: policy.campaignCapMinor, clientDailyCapMinor: policy.clientDailyCapMinor,
        source, nativeAutoOff: true as const, noConcurrentChanges: true as const, canSend: async () => true };
    }, providerPosts() { return calls.filter(c => c.host === "business-api.tiktok.com" && c.method === "POST"); } };
}

describe("exact GMV campaign delivery telemetry", () => {
  it.each([
    ["CAMPAIGN_STATUS_ENABLE", "ENABLED"], ["CAMPAIGN_STATUS_BUDGET_EXCEED", "CAMPAIGN_BUDGET_EXHAUSTED"],
    ["CAMPAIGN_STATUS_TTS_ACCOUNT_BALANCE_INSUFFICIENT", "OTHER"], ["STATUS_NOT_DELIVERY", "OTHER"],
    ["CAMPAIGN_STATUS_BUDGET_EXHAUSTED", "OTHER"], ["campaign_status_budget_exceed", "OTHER"],
    [null, "OTHER"], ["", "OTHER"], [40001, "OTHER"],
  ] as const)("normalizes only exact scoped provider status %j", async (secondaryStatus, expected) => {
    const h = harness({ secondaryStatus });
    const view = await h.adapters.readContext(CAMPAIGN, "manual");
    expect(view.campaignDeliveryStatus).toBe(expected);
    expect(view).not.toHaveProperty("secondary_status");
    const listed = h.queries.find(x => x.path.endsWith("/gmv_max/campaign/get/") && x.query.filtering.includes("campaign_ids"));
    expect(JSON.parse(listed!.query.fields)).toContain("secondary_status");
    expect(h.providerPosts()).toHaveLength(0);
  });

  it("does not invent an absent status or include delivery changes in the budget fingerprint", async () => {
    const h = harness();
    const absent = await h.adapters.readContext(CAMPAIGN, "manual");
    expect(absent).not.toHaveProperty("campaignDeliveryStatus");
    h.setSecondaryStatus("CAMPAIGN_STATUS_ENABLE");
    const enabled = await h.adapters.readContext(CAMPAIGN, "manual");
    h.setSecondaryStatus("CAMPAIGN_STATUS_BUDGET_EXCEED");
    const exhausted = await h.adapters.readContext(CAMPAIGN, "manual");
    expect(enabled.campaignDeliveryStatus).toBe("ENABLED");
    expect(exhausted.campaignDeliveryStatus).toBe("CAMPAIGN_BUDGET_EXHAUSTED");
    expect(new Set([absent.fingerprint, enabled.fingerprint, exhausted.fingerprint]).size).toBe(1);
    expect(await h.adapters.readPreArmContext!(CAMPAIGN)).not.toHaveProperty("campaignDeliveryStatus");
  });

  it("separates ROI-only adoption evidence from the exact writer fingerprint across all provider reads", async () => {
    const h = harness({ extraClient: "ashopbytheta", room: "ONGOING", detectRoom: true, roomCost: "20.00" });
    const before = await h.adapters.readScheduledLiveContext!(CAMPAIGN, ROOM, true);
    expect(before.settingsFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(before.nonRoiSettingsFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const expected = { settingsFingerprint: before.settingsFingerprint, nonRoiSettingsFingerprint: before.nonRoiSettingsFingerprint };
    expect(await h.adapters.readPreArmContext!(CAMPAIGN)).toMatchObject(expected);
    expect(await h.adapters.readAutoDetectContext!(CAMPAIGN)).toMatchObject(expected);
    h.edit(3000);
    h.setSecondaryStatus("CAMPAIGN_STATUS_BUDGET_EXCEED");
    h.setDetailSecondaryStatus("CAMPAIGN_STATUS_BUDGET_EXCEED");
    const budgetEdit = await h.adapters.readScheduledLiveContext!(CAMPAIGN, ROOM, true);
    expect(budgetEdit).toMatchObject(expected);
    expect(budgetEdit.fingerprint).not.toBe(before.fingerprint);
    h.setRoi(16);
    const settingsEdit = await h.adapters.readScheduledLiveContext!(CAMPAIGN, ROOM, true);
    expect(settingsEdit.settingsFingerprint).not.toBe(budgetEdit.settingsFingerprint);
    expect(settingsEdit.fingerprint).not.toBe(budgetEdit.fingerprint);
    expect(settingsEdit.nonRoiSettingsFingerprint).toBe(before.nonRoiSettingsFingerprint);
    expect(await h.adapters.readPreArmContext!(CAMPAIGN)).toMatchObject({ settingsFingerprint: settingsEdit.settingsFingerprint,
      nonRoiSettingsFingerprint: settingsEdit.nonRoiSettingsFingerprint, fingerprint: settingsEdit.fingerprint });
    expect(h.providerPosts()).toHaveLength(0);
  });

  it.each([
    ["campaign name", { campaign_name: "Another campaign name" }],
    ["schedule", { schedule_start_time: "2025-03-15 08:15:00" }],
    ["native budget policy", { auto_budget_enabled: true }],
    ["nested promotion ROI", { promotion_days: { is_enabled: false, adjusted_roas_bid: 12 } }],
  ] as const)("keeps a %s change in the non-ROI evidence", async (_label, campaignInfo) => {
    const h = harness(), edited = harness({ campaignInfo });
    const before = await h.adapters.readPreArmContext!(CAMPAIGN), after = await edited.adapters.readPreArmContext!(CAMPAIGN);
    expect(before?.nonRoiSettingsFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(after?.nonRoiSettingsFingerprint).not.toBe(before?.nonRoiSettingsFingerprint);
    expect(after?.settingsFingerprint).not.toBe(before?.settingsFingerprint);
    expect(after?.fingerprint).not.toBe(before?.fingerprint);
    expect((await edited.adapters.readScheduledLiveContext!(CAMPAIGN)).nonRoiSettingsFingerprint).toBe(after?.nonRoiSettingsFingerprint);
    expect(edited.providerPosts()).toHaveLength(0);
  });

  it("rejects the budget writer before POST if ROI changes after the proposal", async () => {
    const h = harness({ scheduledLive: true, room: "ONGOING", detectRoom: true, roomCost: "20.00" });
    const input = await h.input(336_000, "auto");
    const old = await h.adapters.readScheduledLiveContext!(CAMPAIGN, ROOM, true);
    h.setRoi(16); // Provider timestamp is deliberately unchanged in this fixture.
    const latest = await h.adapters.readScheduledLiveContext!(CAMPAIGN, ROOM, true);
    expect(latest.nonRoiSettingsFingerprint).toBe(old.nonRoiSettingsFingerprint);
    expect(latest.fingerprint).not.toBe(input.fingerprint);
    expect(await h.adapters.dispatch({ ...input, evidenceMode: LIVE_ROOM_SPEND_TREND, autoDetectLive: true })).toEqual({ outcome: "NOT_SENT" });
    expect(h.providerPosts()).toHaveLength(0);
  });
});

describe("exact read-only scheduled Auto context", () => {
  it.each(SCHEDULED_SCOPES)("can read an enabled future %s campaign without a spend row, room or write", async (_scope, options) => {
    const h = harness({ ...options, targetAbsent: true, nativeUnknown: true, campaignInfo: {
      schedule_type: "SCHEDULE_START_END", schedule_start_time: "2025-03-15 10:00:00", schedule_end_time: "2025-03-15 12:00:00" } });
    await expect(h.adapters.readPreArmContext!(CAMPAIGN)).resolves.toEqual({ campaignId: CAMPAIGN,
      reportingDate: TODAY, observedAt: NOW, budgetMinor: 280_000, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      settingsFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), nonRoiSettingsFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), nativeAutoState: "UNKNOWN",
      scheduleStartAt: "2025-03-15T10:00:00.000Z", scheduleEndAt: "2025-03-15T12:00:00.000Z" });
    expect(h.calls.map(x => [x.method, x.path])).toEqual([["GET", "/open_api/v1.3/advertiser/info/"],
      ["GET", "/open_api/v1.3/gmv_max/campaign/get/"], ["GET", "/open_api/v1.3/campaign/gmv_max/info/"]]);
    expect(h.queries[1].query.filtering).toBe(JSON.stringify({ gmv_max_promotion_types: ["LIVE_GMV_MAX"], campaign_ids: [CAMPAIGN] }));
    expect(h.queries[2].query.campaign_id).toBe(CAMPAIGN);
    expect(h.providerPosts()).toHaveLength(0);
  });

  it("shares the real writer fingerprint and does not relax current spend or schedule checks", async () => {
    const h = harness({ extraClient: "ashopbytheta" });
    const armed = await h.adapters.readPreArmContext!(CAMPAIGN), current = await h.adapters.readContext(CAMPAIGN, "manual");
    expect(armed?.fingerprint).toBe(current.fingerprint);
    expect(armed?.scheduleEndAt).toBeNull();
    const future = harness({ extraClient: "bubpa_shop189", campaignInfo: { schedule_start_time: "2025-03-15 11:00:00" } });
    await expect(future.adapters.readPreArmContext!(CAMPAIGN)).resolves.not.toBeNull();
    await expect(future.adapters.readContext(CAMPAIGN, "manual")).rejects.toThrow();
    const noSpend = harness({ extraClient: "ashopbytheta", targetAbsent: true });
    await expect(noSpend.adapters.readPreArmContext!(CAMPAIGN)).resolves.not.toBeNull();
    await expect(noSpend.adapters.readContext(CAMPAIGN, "manual")).rejects.toThrow();
    expect(future.providerPosts()).toHaveLength(0);
    expect(noSpend.providerPosts()).toHaveLength(0);
  });

  it.each(["DISABLE", "DELETE"])("returns null for exact, confirmed inactive operation %s", async listedStatus => {
    const h = harness({ extraClient: "ashopbytheta", listedStatus });
    await expect(h.adapters.readPreArmContext!(CAMPAIGN)).resolves.toBeNull();
    expect(h.calls).toHaveLength(2);
    expect(h.providerPosts()).toHaveLength(0);
  });

  it("returns null for a complete exact absent campaign or an expired exact schedule", async () => {
    const absent = harness({ extraClient: "bubpa_shop189", campaignList: { page_info: pageInfo(0, 1, 0), list: [] } });
    await expect(absent.adapters.readPreArmContext!(CAMPAIGN)).resolves.toBeNull();
    expect(absent.calls).toHaveLength(2);
    const expired = harness({ extraClient: "bubpa_shop189", campaignInfo: {
      schedule_type: "SCHEDULE_START_END", schedule_start_time: "2025-03-15 07:00:00", schedule_end_time: "2025-03-15 09:00:00" } });
    await expect(expired.adapters.readPreArmContext!(CAMPAIGN)).resolves.toBeNull();
    expect(expired.calls).toHaveLength(3);
  });

  it.each([
    { currency: "USD" }, { timezone: "UTC" }, { wrongProviderScope: true }, { listedStatus: "UNKNOWN" },
    { campaignList: { page_info: pageInfo(1, 1, 2), list: [] } },
    { campaignInfo: { identity_list: [] } }, { campaignInfo: { campaign_id: OTHER_CAMPAIGN } },
    { campaignInfo: { operation_status: "DISABLE" } }, { campaignInfo: { modify_time: "2025-03-15 08:56:00" } },
    { campaignInfo: { schedule_type: "SCHEDULE_START_END" } },
    { campaignInfo: { schedule_type: "SCHEDULE_START_END", schedule_end_time: "2025-03-15 08:00:00" } },
  ])("throws instead of treating uncertain or foreign evidence as absent: %j", async options => {
    const h = harness({ ...options, extraClient: "ashopbytheta" });
    await expect(h.adapters.readPreArmContext!(CAMPAIGN)).rejects.toThrow("WEB_BUDGET_ADAPTER_UNVERIFIED");
    expect(h.providerPosts()).toHaveLength(0);
  });

  it.each(SCHEDULED_SCOPES)("forces a separately verified room only for the scheduled %s read", async (scope, options) => {
    const h = harness({ ...options, room: "ONGOING" });
    const active = await h.adapters.readScheduledLiveContext!(CAMPAIGN);
    expect(active).toMatchObject({ campaignId: CAMPAIGN, spendMinor: 210_009, deliveryVerified: true, liveDeliveryState: "LIVE",
      liveSessionId: ROOM, liveSessionStartedAt: "2025-03-15T08:55:00.000Z" });
    expect(h.calls.filter(x => x.path.endsWith("/advertiser/info/"))).toHaveLength(1);
    expect(h.calls.filter(x => x.path.endsWith("/gmv_max/report/get/"))).toHaveLength(1);
    if (["punpan_020", "srihiw", "nnshop5719"].includes(scope)) {
      h.calls.length = 0;
      await expect(h.adapters.readContext(CAMPAIGN)).resolves.toMatchObject({ deliveryVerified: false, liveDeliveryState: "UNKNOWN" });
      expect(h.calls.filter(x => x.path.endsWith("/gmv_max/report/get/"))).toHaveLength(0);
    }
    expect(h.providerPosts()).toHaveLength(0);
  });

  it("rejects stale or day-crossing samples instead of returning evidence from a previous reporting day", async () => {
    for (const [before, after] of [[NOW, "2025-03-15T09:00:21.000Z"], ["2025-03-15T16:59:59.000Z", "2025-03-15T17:00:00.000Z"]]) {
      let nowCalls = 0;
      const h = harness({ extraClient: "ashopbytheta", now: () => new Date(++nowCalls < 3 ? before : after) });
      await expect(h.adapters.readPreArmContext!(CAMPAIGN)).rejects.toThrow("WEB_BUDGET_ADAPTER_UNVERIFIED");
      expect(h.providerPosts()).toHaveLength(0);
    }
  });
});

describe("verified room dispatch boundary", () => {
  it.each(SCHEDULED_SCOPES)("%s uses current room evidence for exactly one +20%% send when authorized", async (_scope, options) => {
    const h = harness({ ...options, scheduledLive: true, extraLive: true, room: "ONGOING", nativeUnknown: true });
    const input = await h.input(336_000, "auto");
    const before = h.calls.length;
    await expect(h.adapters.dispatch({ ...input, evidenceMode: LIVE_ROOM_SPEND_TREND })).resolves.toMatchObject({
      outcome: "APPLIED_VERIFIED", observedBudgetMinor: 336_000 });
    const dispatchCalls = h.calls.slice(before);
    expect(dispatchCalls.filter(x => x.path.endsWith("/gmv_max/report/get/") && x.method === "GET")).toHaveLength(1);
    expect(h.providerPosts()).toHaveLength(1);
  });

  it.each(["not-authorized", "room-ended", "room-missing", "non-exact"] as const)("keeps the hybrid send closed when %s", async scenario => {
    const h = harness({ scheduledLive: scenario !== "not-authorized", room: scenario === "room-missing" ? undefined : scenario === "room-ended" ? "END" : "ONGOING" });
    const input = await h.input(scenario === "non-exact" ? 336_001 : 336_000, "auto");
    await expect(h.adapters.dispatch({ ...input, evidenceMode: LIVE_ROOM_SPEND_TREND })).resolves.toEqual({ outcome: "NOT_SENT" });
    expect(h.providerPosts()).toHaveLength(0);
  });

  it("does not impose the new room check on an already-authorized legacy spend-trend send", async () => {
    for (const options of [{ spendTrend: true }, { extra: true, extraLive: true, sriTrend: true }]) {
      const h = harness({ ...options, room: "END", nativeUnknown: true });
      const { nativeAutoOff: _, noConcurrentChanges: __, ...input } = await h.input(336_000, "auto");
      await expect(h.adapters.dispatch({ ...input, evidenceMode: "spend-trend" })).resolves.toMatchObject({ outcome: "APPLIED_VERIFIED" });
      expect(h.calls.filter(x => x.path.endsWith("/gmv_max/report/get/"))).toHaveLength(0);
      expect(h.providerPosts()).toHaveLength(1);
    }
  });
});

describe("independent auto-detected room and strict budget contexts", () => {
  it.each(SCHEDULED_SCOPES)("can bind %s from corroborated current room without the campaign spend report or room cost", async (_scope, options) => {
    const h = harness({ ...options, targetAbsent: true, room: "ONGOING", detectRoom: true });
    const detected = await h.adapters.readAutoDetectContext!(CAMPAIGN);
    expect(detected).toMatchObject({ campaignId: CAMPAIGN, liveDeliveryState: "LIVE", liveSessionId: ROOM, deliveryVerified: true,
      liveSessionStartedAt: "2025-03-15T08:55:00.000Z" });
    expect(detected).not.toHaveProperty("roomSpendMinor");
    expect(h.calls.filter(x => x.path.endsWith("/report/integrated/get/"))).toHaveLength(0);
    expect(h.calls.filter(x => x.path.endsWith("/identity/live/get/"))).toHaveLength(1);
    await expect(h.adapters.readScheduledLiveContext!(CAMPAIGN, ROOM, true)).rejects.toThrow("WEB_BUDGET_ADAPTER_UNVERIFIED");
    expect(h.providerPosts()).toHaveLength(0);
  });

  it("will not bind an ongoing room to a campaign whose schedule has not started", async () => {
    const h = harness({ room: "ONGOING", detectRoom: true, campaignInfo: { schedule_start_time: "2025-03-15 10:00:00" } });
    const stat = await h.adapters.readAutoDetectContext!(CAMPAIGN);
    expect(stat).toMatchObject({ campaignId: CAMPAIGN, scheduleStartAt: "2025-03-15T10:00:00.000Z" });
    expect(stat).not.toHaveProperty("liveSessionId");
    expect(h.calls).toHaveLength(3);
  });

  it("feeds fresh exact room cost and real campaign spend into the strict context", async () => {
    const h = harness({ room: "ONGOING", detectRoom: true, roomCost: "21.35" });
    await expect(h.adapters.readScheduledLiveContext!(CAMPAIGN, ROOM, true)).resolves.toMatchObject({
      liveDeliveryState: "LIVE", liveSessionId: ROOM, roomSpendMinor: 2135, spendMinor: 210009 });
    await expect(h.adapters.readScheduledLiveContext!(CAMPAIGN, OTHER_CAMPAIGN, true)).resolves.toMatchObject({ liveDeliveryState: "UNKNOWN" });
    expect(h.providerPosts()).toHaveLength(0);
  });

  it.each(["ready", "missing-cost", "ended-identity"] as const)("rechecks both sources and room cost on new hybrid dispatch: %s", async scenario => {
    const h = harness({ scheduledLive: true, room: "ONGOING", detectRoom: true,
      ...(scenario !== "missing-cost" ? { roomCost: "25.20" } : {}), ...(scenario === "ended-identity" ? { identityLive: "ended" as const } : {}) });
    const input = await h.input(336_000, "auto");
    const ready = scenario === "ready";
    const result = await h.adapters.dispatch({ ...input, evidenceMode: LIVE_ROOM_SPEND_TREND, autoDetectLive: true,
      canSend: async x => { if (ready) expect(x).toMatchObject({ roomSpendMinor: 2520, liveSessionId: ROOM }); return true; } });
    expect(result.outcome).toBe(ready ? "APPLIED_VERIFIED" : "NOT_SENT");
    expect(h.providerPosts()).toHaveLength(ready ? 1 : 0);
    expect(h.calls.filter(x => x.path.endsWith("/identity/live/get/"))).toHaveLength(1);
  });
});

describe("Ppan manual-only verified zero spend", () => {
  it("keeps the integrated account total when the complete GMV day has an explicit zero for each omitted row", async () => {
    const h = harness({ targetAbsent: true, daily: page => ({ page_info: pageInfo(3, page, 2),
      list: page === 1 ? [dailyRow(OTHER_CAMPAIGN, 20), dailyRow(MISSING_CAMPAIGN, 0)] : [dailyRow(CAMPAIGN)] }) });
    const read = await h.adapters.readContext(CAMPAIGN, "manual");
    expect(read).toMatchObject({ campaignId: CAMPAIGN, reportingDate: TODAY, spendMinor: 0, aggregateSpendMinor: 2_000,
      providerSpendObservedAt: null, deliveryVerified: false });
    const input = await h.input(310_000, "manual");
    expect(await h.adapters.dispatch(input)).toMatchObject({ outcome: "APPLIED_VERIFIED", observedBudgetMinor: 310_000 });
    expect(h.calls.filter(x => x.path.endsWith("/gmv_max/report/get/"))).toHaveLength(6);
    expect(h.providerPosts()).toHaveLength(1);
  });

  it.each([
    ["no exact row", [dailyRow(MISSING_CAMPAIGN)]],
    ["no explicit cost", [dailyRow(CAMPAIGN, null)]],
    ["nonzero exact cost", [dailyRow(CAMPAIGN, "0.01")]],
    ["nonzero other omitted cost", [dailyRow(CAMPAIGN), dailyRow(MISSING_CAMPAIGN, "0.01")]],
    ["unknown other omitted cost", [dailyRow(CAMPAIGN), dailyRow(MISSING_CAMPAIGN, "--")]],
    ["dedicated cost higher than integrated", [dailyRow(CAMPAIGN), dailyRow(OTHER_CAMPAIGN, "20.01")]],
    ["duplicate target", [dailyRow(CAMPAIGN), dailyRow(CAMPAIGN)]],
    ["wrong date", [dailyRow(CAMPAIGN, 0, { stat_time_day: "2025-03-14" })]],
    ["foreign advertiser", [dailyRow(CAMPAIGN, 0, { advertiser_id: "1234567890198765" })]],
    ["Shop row", [dailyRow(CAMPAIGN, 0, { store_id: OTHER_CAMPAIGN })]],
  ])("does not substitute zero with %s", async (_label, list) => {
    const h = harness({ targetAbsent: true, daily: () => ({ page_info: pageInfo(list.length), list }) });
    await expect(h.adapters.readContext(CAMPAIGN, "manual")).rejects.toThrow("UNVERIFIED");
    expect(h.providerPosts()).toHaveLength(0);
  });

  it("does not fall back from incomplete/mis-scoped integrated spend, wrong currency, or an incomplete dedicated day", async () => {
    for (const h of [harness({ targetAbsent: true, integrated: { page_info: pageInfo(2) } }),
      harness({ targetAbsent: true, integrated: { advertiser_id: SRIHIW.advertiserId } }), harness({ targetAbsent: true, currency: "USD" })]) {
      await expect(h.adapters.readContext(CAMPAIGN, "manual")).rejects.toThrow();
      expect(h.calls.some(x => x.path.endsWith("/gmv_max/report/get/"))).toBe(false);
    }
    const truncated = harness({ targetAbsent: true, daily: () => ({ page_info: pageInfo(2), list: [dailyRow(CAMPAIGN)] }) });
    await expect(truncated.adapters.readContext(CAMPAIGN, "manual")).rejects.toThrow("UNVERIFIED");
  });

  it("refuses normal and trend Auto, keeps other creators unchanged, and rechecks the manual fallback before send", async () => {
    const h = harness({ targetAbsent: true, spendTrend: true });
    await expect(h.adapters.readContext(CAMPAIGN)).rejects.toThrow("UNVERIFIED");
    await expect(h.adapters.readContext(CAMPAIGN, "auto")).rejects.toThrow("UNVERIFIED");
    await expect(harness({ extra: true, extraLive: true, targetAbsent: true }).adapters.readContext(CAMPAIGN, "manual")).rejects.toThrow("UNVERIFIED");
    expect(h.calls.some(x => x.path.endsWith("/gmv_max/report/get/"))).toBe(false);
    const input = await h.input(336_000, "manual");
    const { nativeAutoOff: _, noConcurrentChanges: __, ...common } = input;
    expect(await h.adapters.dispatch({ ...input, source: "auto" })).toEqual({ outcome: "NOT_SENT" });
    expect(await h.adapters.dispatch({ ...common, evidenceMode: "spend-trend" })).toEqual({ outcome: "NOT_SENT" });
    h.setDaily(() => ({ page_info: pageInfo(1), list: [dailyRow(CAMPAIGN, "0.01")] }));
    expect(await h.adapters.dispatch(input)).toEqual({ outcome: "NOT_SENT" });
    expect(h.providerPosts()).toHaveLength(0);
  });

  it("includes other integrated spend when rejecting a manual fallback budget that exceeds the total cap", async () => {
    const h = harness({ targetAbsent: true });
    const input = await h.input(310_000, "manual");
    h.setOtherSpend("4000.01");
    expect(await h.adapters.dispatch(input)).toEqual({ outcome: "NOT_SENT" });
    expect(h.providerPosts()).toHaveLength(0);
  });
});

describe("Ppan web budget boundary", () => {
  it("reads fixed policy with a distinct key and validates lease/outcome envelopes", async () => {
    const { adapters } = harness();
    expect(await adapters.readPolicy()).toEqual({ revision: 4, campaignCapMinor: 600_000, clientDailyCapMinor: 700_000, readAt: NOW, locked: false });
    expect(await adapters.acquireLease(OP, 4)).toMatchObject({ locked: true, operationId: OP, expiresAt: LEASE_END });
    await expect(adapters.finishLease(OP, "NOT_SENT")).resolves.toBeUndefined();
    await expect(harness({ readAt: "2025-03-15T08:55:00.000Z" }).adapters.readPolicy()).rejects.toThrow("UNVERIFIED");
    const invalid = harness({ policyKey: "weak" });
    await expect(invalid.adapters.readPolicy()).rejects.toThrow("UNVERIFIED");
    expect(invalid.calls).toHaveLength(0);
  });

  it("uses an exact fresh scoped budget and returns success only after two matching readbacks", async () => {
    const h = harness();
    const input = await h.input();
    const before = h.calls.length;
    expect(await h.adapters.dispatch(input)).toEqual({ outcome: "APPLIED_VERIFIED", observedBudgetMinor: 310_000,
      observedFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(h.providerPosts()).toHaveLength(1);
    const after = h.calls.slice(before);
    expect(after.slice(after.findIndex(x => x.method === "POST") + 1).filter(x => x.path.endsWith("/info/"))).toHaveLength(2);
  });

  it("can safely request a decrease above spend", async () => {
    const h = harness();
    expect(await h.adapters.dispatch(await h.input(255_000))).toMatchObject({ outcome: "APPLIED_VERIFIED", observedBudgetMinor: 255_000 });
  });

  it("dispatches exact Ppan spend-trend with unknown native state, and rejects cross-scope and non-20% requests", async () => {
    for (const [h, target, outcome] of [
      [harness({ nativeUnknown: true, spendTrend: true }), 336_000, "APPLIED_VERIFIED"],
      [harness({ nativeUnknown: true }), 336_000, "NOT_SENT"],
      [harness({ nativeUnknown: true, spendTrend: true }), 336_001, "NOT_SENT"],
      [harness({ extra: true, extraLive: true, nativeUnknown: true, spendTrend: true }), 336_000, "NOT_SENT"],
      [harness({ competing: true, spendTrend: true }), 336_000, "NOT_SENT"],
    ] as const) {
      const { nativeAutoOff: _, noConcurrentChanges: __, ...input } = await h.input(target);
      expect(await h.adapters.dispatch({ ...input, evidenceMode: "spend-trend" })).toMatchObject({ outcome });
      expect(h.providerPosts()).toHaveLength(outcome === "APPLIED_VERIFIED" ? 1 : 0);
    }
  });

  it("requires explicit Ppan-only spend mode without opening the shared Auto switch", () => {
    const env = { CREATOR_READ_ENABLED: "true", CREATOR_WEB_BUDGET_MODE: "live", CREATOR_WEB_BUDGET_LIVE_ENABLED: "true",
      CREATOR_AUTO_BUDGET_PPAN_SPEND_TREND_LIVE_ENABLED: "true", CREATOR_AUTO_BUDGET_MODE: "shadow", CREATOR_AUTO_BUDGET_SRIHIW_MODE: "live" };
    expect(configuredPpanSpendTrendLive(env)).toBe(true);
    expect(configuredCreatorAutoBudgetMode(env)).toBe("shadow");
    expect(configuredCreatorAutoBudgetMode(env, "srihiw")).toBe("disabled");
    expect(configuredPpanSpendTrendLive({ ...env, CREATOR_WEB_BUDGET_LIVE_ENABLED: "false" })).toBe(false);
  });

  it.each(["disabled", "dry-run"])("does not dispatch in mode %s", async mode => {
    const h = harness({ mode });
    expect(await h.adapters.dispatch(await h.input())).toEqual({ outcome: "NOT_SENT" });
    expect(h.providerPosts()).toHaveLength(0);
  });

  it.each(["native", "legacy", "manual edit", "spent through target", "client cap", "expires", "revoked operator"])("blocks %s before write", async scenario => {
    const h = harness({ competing: scenario === "native", legacy: scenario === "legacy" });
    const input = await h.input();
    if (scenario === "manual edit") h.edit(2900);
    if (scenario === "spent through target") h.setSpend("3100.00");
    if (scenario === "client cap") h.setOtherSpend("4000.00");
    if (scenario === "expires") input.notAfter = "2025-03-15T09:00:02.000Z";
    if (scenario === "revoked operator") input.canSend = async () => false;
    expect(await h.adapters.dispatch(input)).toEqual({ outcome: "NOT_SENT" });
    expect(h.providerPosts()).toHaveLength(0);
  });

  it.each(["unknown", "roi-drift", "reject-with-drift", "reject"] as const)("never resends a provider result: %s", async providerResult => {
    const h = harness({ providerResult });
    expect(await h.adapters.dispatch(await h.input())).toEqual({ outcome: "OUTCOME_UNKNOWN" });
    expect(h.providerPosts()).toHaveLength(1);
  });
});

describe("Srihiw exact budget writer boundary", () => {
  it("uses only Srihiw's own exact opt-in and leaves all other Creator Trend writers disabled", async () => {
    for (const [h, expected] of [
      [harness({ extra: true, extraLive: true, nativeUnknown: true, sriTrend: true }), "APPLIED_VERIFIED"],
      [harness({ extra: true, extraLive: true, nativeUnknown: true, spendTrend: true }), "NOT_SENT"],
      [harness({ extraClient: "nnshop5719", extraLive: true, sriTrend: true }), "NOT_SENT"],
      [harness({ nativeUnknown: true, sriTrend: true }), "NOT_SENT"],
    ] as const) {
      const { nativeAutoOff: _, noConcurrentChanges: __, ...input } = await h.input(336_000);
      expect(await h.adapters.dispatch({ ...input, evidenceMode: "spend-trend" })).toMatchObject({ outcome: expected });
      expect(h.providerPosts()).toHaveLength(expected === "APPLIED_VERIFIED" ? 1 : 0);
    }
  });
  it("uses the separately verified scope, policy lease and budget-only provider mutation", async () => {
    const h = harness({ extra: true, extraLive: true });
    expect(await h.adapters.acquireLease(OP, 4)).toMatchObject({ locked: true, operationId: OP });
    expect(await h.adapters.dispatch(await h.input())).toMatchObject({ outcome: "APPLIED_VERIFIED", observedBudgetMinor: 310_000 });
    expect(h.providerPosts()).toHaveLength(1);
  });
  it("keeps a Ppan live flag from enabling Srihiw and fails closed on a foreign row", async () => {
    const disabled = harness({ extra: true });
    expect(await disabled.adapters.dispatch(await disabled.input())).toEqual({ outcome: "NOT_SENT" });
    expect(disabled.providerPosts()).toHaveLength(0);
    const cross = harness({ extra: true, extraLive: true, wrongProviderScope: true });
    await expect(cross.input()).rejects.toThrow();
    expect(cross.providerPosts()).toHaveLength(0);
  });
});

describe("additional exact live budget scopes", () => {
  it.each(["nnshop5719", "ashopbytheta"] as const)("%s uses its own lease, exact advertiser token and a single budget-only send", async extraClient => {
    const blocked = harness({ extraClient });
    expect(await blocked.adapters.dispatch(await blocked.input())).toEqual({ outcome: "NOT_SENT" });
    expect(blocked.providerPosts()).toHaveLength(0);
    const h = harness({ extraClient, extraLive: true });
    expect(await h.adapters.acquireLease(OP, 4)).toMatchObject({ locked: true, operationId: OP });
    expect(await h.adapters.dispatch(await h.input())).toMatchObject({ outcome: "APPLIED_VERIFIED", observedBudgetMinor: 310_000 });
    expect(h.providerPosts()).toHaveLength(1);
    const wrong = harness({ extraClient, extraLive: true, wrongProviderScope: true });
    await expect(wrong.input()).rejects.toThrow();
    expect(wrong.providerPosts()).toHaveLength(0);
  });

  it("keeps global and neighboring flags from granting unconfigured or other advertiser access", () => {
    const env = { CREATOR_READ_ENABLED: "true", CREATOR_WEB_BUDGET_MODE: "live", CREATOR_WEB_BUDGET_LIVE_ENABLED: "true",
      CREATOR_AUTO_BUDGET_MODE: "live", CREATOR_AUTO_BUDGET_LIVE_ENABLED: "true",
      CREATOR_WEB_NNSHOP5719_BUDGET_MODE: "live", CREATOR_WEB_NNSHOP5719_BUDGET_LIVE_ENABLED: "true",
      CREATOR_AUTO_BUDGET_NNSHOP5719_MODE: "live", CREATOR_AUTO_BUDGET_NNSHOP5719_LIVE_ENABLED: "true",
      CREATOR_AUTO_BUDGET_ASHOPBYTHETA_MODE: "live", CREATOR_AUTO_BUDGET_ASHOPBYTHETA_LIVE_ENABLED: "true" };
    expect(configuredCreatorAutoBudgetMode(env, "nnshop5719")).toBe("live");
    expect(configuredCreatorAutoBudgetMode(env, "ashopbytheta")).toBe("disabled");
    expect(configuredCreatorWebBudgetMode(env, "shop-other" as CreatorBudgetScope)).toBe("disabled");
    expect(creatorBudgetPolicyPath("constructor" as CreatorBudgetScope)).toBeNull();
  });
});

describe("Web-only cap policy bridge", () => {
  const initial = { schemaVersion: 1, clientId: "srihiw", configured: false, readAt: NOW, locked: false, capWriteEnabled: true };
  const set = { ...initial, configured: true, revision: 1, campaignCapMinor: 500000, clientDailyCapMinor: 500000 };
  function setup(responses: Response[]) {
    const calls: { path: string; method?: string; body?: unknown }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("whale-buddy-ads-control-plane.onrender.com");
      expect(new Headers(init?.headers).get("x-creator-web-key")).toBe(KEY);
      expect(new Headers(init?.headers).get("access-token")).toBeNull();
      calls.push({ path: url.pathname, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const response = responses.shift();
      if (!response) throw new Error("socket closed");
      return response;
    }) as typeof fetch;
    return { calls, api: createCreatorWebCapAdapters({ fetchImpl, now: () => new Date(NOW), env: { CREATOR_WEB_POLICY_BRIDGE_KEY: KEY } }) };
  }
  it("only initializes Srihiw's missing cap with revision zero and the authenticated actor", async () => {
    const h = setup([Response.json(initial), Response.json(initial), Response.json(set)]);
    expect(await h.api.status("srihiw")).toEqual({ cap: null, capEditAllowed: true });
    await expect(h.api.update("srihiw", 22, 0, 500000, async () => true)).resolves.toEqual({ capMinor: 500000, revision: 1 });
    expect(h.calls.map(x => [x.method, x.path])).toEqual([["GET", "/internal/automation/srihiw/policy"],
      ["GET", "/internal/automation/srihiw/policy"], ["POST", "/internal/automation/srihiw/policy/cap"]]);
    expect(h.calls[2].body).toEqual({ revision: 0, capMinor: 500000, actorUserId: 22 });
  });
  it("does not send on stale, locked, revoked, or wrong-scope cap read", async () => {
    for (const [raw, code, role] of [[set, "CAP_CHANGED", true], [{ ...set, locked: true }, "CAP_LOCKED", true],
      [initial, "BUDGET_OPERATOR_DENIED", false], [{ ...initial, clientId: "punpan_020" }, "CAP_UPDATE_UNCONFIRMED", true]] as const) {
      const h = setup([Response.json(raw)]);
      await expect(h.api.update("srihiw", 22, "locked" in raw && raw.locked ? 1 : 0, 555000, async () => role)).rejects.toMatchObject({ code });
      expect(h.calls.map(c => c.method)).toEqual(["GET"]);
    }
  });
  it("uses the same policy compare-and-set and treats an unknown send outcome as refresh-only", async () => {
    const current = { ...policy, capWriteEnabled: true, clientDailyCapMinor: policy.campaignCapMinor };
    const changed = setup([Response.json(current), Response.json({ error: { code: "POLICY_CHANGED" } }, { status: 409 })]);
    await expect(changed.api.update("punpan_020", 22, 4, 550000, async () => true)).rejects.toMatchObject({ code: "CAP_CHANGED", httpStatus: 409 });
    expect(changed.calls.at(-1)?.path).toBe("/internal/automation/ppan/policy/cap");
    const unknown = setup([Response.json(current)]);
    await expect(unknown.api.update("punpan_020", 22, 4, 550000, async () => true)).rejects.toMatchObject({ code: "CAP_UPDATE_UNCONFIRMED" });
    expect(unknown.calls.filter(c => c.method === "POST")).toHaveLength(1);
  });
});
