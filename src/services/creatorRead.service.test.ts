import { describe, expect, it, vi } from "vitest";
import { CREATOR_BINDING as B, createCreatorReader, minor } from "./creatorRead.service";

const TOKEN = "secret-token-canary-not-for-output";
const CAMPAIGN = "1881012999140370";
const OTHER = "1880857574137137";
const EXPIRED = { schedule_type: "SCHEDULE_START_END", schedule_start_time: "2026-11-05 23:00:00", schedule_end_time: "2026-11-06 08:00:00" };
const FUTURE = { schedule_type: "START_END", schedule_start_time: "2026-11-06 10:00:00", schedule_end_time: "2026-11-06 13:00:00" };
const ENABLED_PAIR = [CAMPAIGN, OTHER].map(campaign_id => ({ advertiser_id: B.advertiserId, campaign_id, operation_status: "ENABLE" }));
function setup(overrides: Record<string, any> = {}) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  let clock = Date.parse(overrides.now ?? "2026-11-06T08:00:00Z");
  const setTime = (time: string) => { clock = Date.parse(time); };
  const info = { advertiser_id: B.advertiserId, campaign_id: CAMPAIGN, campaign_name: "Ppan Creator", shopping_ads_type: "LIVE", operation_status: "ENABLE", budget: 3000, roas_bid: 32,
    identity_list: [{ identity_id: B.identityId, identity_type: B.identityType, identity_authorized_bc_id: B.identityAuthorizedBcId, store_id: null }], ...overrides.info };
  const fetchImpl = vi.fn(async (input: any, init: any) => {
    const url = new URL(input); calls.push({ url, init });
    expect(url.origin).toBe("https://business-api.tiktok.com");
    expect(init.method).toBe("GET"); expect(init.redirect).toBe("error");
    expect(init.headers["Access-Token"]).toBe(TOKEN);
    expect(url.searchParams.has("store_id")).toBe(false);
    let data;
    if (url.pathname.endsWith("/gmv_max/campaign/get/")) data = { list: overrides.campaigns ?? [{ advertiser_id: B.advertiserId, campaign_id: CAMPAIGN, operation_status: "ENABLE" }], page_info: { page: 1, total_page: 1, total_number: (overrides.campaigns ?? [1]).length } };
    else if (url.pathname.endsWith("/campaign/gmv_max/info/")) {
      const requested = url.searchParams.get("campaign_id")!;
      data = { ...info, campaign_id: requested, ...overrides.info, ...overrides.infoById?.[requested] };
    }
    else {
      if (overrides.timeAtReport) setTime(overrides.timeAtReport);
      if (overrides.reportError) throw new Error(TOKEN + " raw URL must stay private");
      const list = overrides.report ?? [
        { dimensions: { campaign_id: CAMPAIGN, country_code: "TH", stat_time_day: "2026-11-06 00:00:00" }, metrics: { spend: "2723.52", roi: "99", gmv: "100000" } },
        { dimensions: { campaign_id: "1880857574137137", country_code: "TH", stat_time_day: "2026-11-06 00:00:00" }, metrics: { spend: "100.00" } },
      ];
      data = { list, page_info: { page: 1, total_page: list.length ? 1 : 0, total_number: list.length, ...overrides.reportPagination } };
    }
    return new Response(JSON.stringify({ code: 0, data }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  const loadToken = vi.fn(async () => TOKEN);
  return { calls, loadToken, setTime, read: createCreatorReader({ loadToken, fetchImpl, now: () => new Date(clock), sleep: async () => {} }) };
}
describe("Ppan-only Creator reader", () => {
  it("reads exact Creator tuple without Shop and keeps actual ROI distinct from ROI Target", async () => {
    const h = setup(), value = await h.read();
    expect(value.binding).toEqual(B);
    expect(value.campaign).toMatchObject({ campaignId: CAMPAIGN, dailyBudgetMinor: 300000, spendMinor: 272352, targetRoi: 32, roi: null, gmvMinor: null, liveViews: null });
    expect(value.campaign).toMatchObject({ scheduleStartAt: null, scheduleEndAt: null });
    expect(value.quality).toMatchObject({ aggregateSpendMinor: 282352, aggregateSpendComplete: true, reportLagSeconds: null });
    expect(value.capabilities).toEqual({ read: true, budgetWrite: false, create: false, pause: false, autoOptimization: false });
    expect(JSON.stringify(value)).not.toContain(TOKEN);
    expect(h.calls).toHaveLength(3);
  });
  it.each([
    [{ schedule_type: "SCHEDULE_START_END", schedule_start_time: "2026-11-05 23:00:00", schedule_end_time: "2026-11-06 16:00:00" },
      "2026-11-05T23:00:00.000Z", "2026-11-06T16:00:00.000Z"],
    [{ schedule_type: "FROM_NOW", schedule_start_time: "2026-11-05 23:00:00" }, "2026-11-05T23:00:00.000Z", null],
    [{ schedule_type: "START_END", schedule_start_time: "2026-11-31 23:00:00", schedule_end_time: "2026-12-06 16:00:00" }, null, null],
    [{ schedule_type: "START_END", schedule_start_time: "2026-11-06 23:00:00", schedule_end_time: "2026-11-06 16:00:00" }, null, null],
    [{ schedule_type: "START_END", schedule_start_time: "2026-11-05 23:00:00" }, null, null],
    [{ schedule_type: "FROM_NOW", schedule_start_time: "2026-11-05 23:00:00", schedule_end_time: "2026-11-06 16:00:00" }, null, null],
    [{ schedule_type: "UNKNOWN", schedule_start_time: "2026-11-05 23:00:00" }, null, null],
  ])("reads only consistent TikTok delivery schedules, without any new API call (%j)", async (info, start, end) => {
    const h = setup({ info });
    expect((await h.read()).campaign).toMatchObject({ campaignId: CAMPAIGN, dailyBudgetMinor: 300000,
      scheduleStartAt: start, scheduleEndAt: end });
    expect(h.calls).toHaveLength(3);
  });
  it("coalesces concurrent requests and does not repeatedly load credentials", async () => {
    const h = setup(); const [a, b] = await Promise.all([h.read(), h.read()]);
    expect(a).toEqual(b); await h.read(); expect(h.loadToken).toHaveBeenCalledTimes(1); expect(h.calls).toHaveLength(3);
  });
  it("accepts the observed without-Shop zero sentinel only with the exact Creator identity", async () => {
    const value = await setup({ info: { store_id: "0", store_authorized_bc_id: "0" } }).read();
    expect(value.campaign.campaignId).toBe(CAMPAIGN); expect(value.binding).toEqual(B);
  });
  it.each([
    { identity_list: [{ identity_id: "wrong", identity_type: B.identityType, identity_authorized_bc_id: B.identityAuthorizedBcId }] },
    { advertiser_id: "7646832328389263378" },
    { shopping_ads_type: "PRODUCT" },
    { store_id: "1234567890123456" },
    { store_authorized_bc_id: "1234567890123456" },
    { identity_list: [{ identity_id: B.identityId, identity_type: B.identityType, identity_authorized_bc_id: B.identityAuthorizedBcId, store_id: "1234567890123456" }] },
    { identity_list: [{ identity_id: B.identityId, identity_type: B.identityType, identity_authorized_bc_id: B.identityAuthorizedBcId, identity_authorized_shop_id: "1234567890123456" }] },
  ])("rejects a mismatched identity/account or Shop campaign before reading spend", async info => {
    const h = setup({ info }); await expect(h.read()).rejects.toMatchObject({ code: "CREATOR_IDENTITY_BINDING_UNVERIFIED" }); expect(h.calls).toHaveLength(2);
  });
  it("does not discover an exactly scoped ENABLE campaign past its proven fixed UTC end", async () => {
    const h = setup({ info: EXPIRED });
    expect(await h.read()).toMatchObject({ campaign: null, nativeAutoBudgetState: "UNKNOWN",
      quality: { aggregateSpendComplete: false, aggregateSpendMinor: null } });
    expect(h.calls).toHaveLength(2);
    const endedPair = setup({ campaigns: ENABLED_PAIR, info: EXPIRED });
    expect((await endedPair.read()).campaign).toBeNull();
    expect(endedPair.calls).toHaveLength(3);
  });
  it("selects the one future campaign after rejecting an expired ENABLE row, while retaining all account spend", async () => {
    const h = setup({ campaigns: ENABLED_PAIR, infoById: { [CAMPAIGN]: { ...EXPIRED, budget: null, roas_bid: null }, [OTHER]: FUTURE } });
    expect(await h.read()).toMatchObject({ campaign: { campaignId: OTHER, spendMinor: 10_000,
      scheduleStartAt: "2026-11-06T10:00:00.000Z", scheduleEndAt: "2026-11-06T13:00:00.000Z" },
      quality: { aggregateSpendComplete: true, aggregateSpendMinor: 282_352 } });
    expect(h.calls.map(({ url }) => url.searchParams.get("campaign_id"))).toEqual([null, CAMPAIGN, OTHER, null]);
  });
  it("never silently selects between two nonexpired enabled campaigns, including one future campaign", async () => {
    const h = setup({ campaigns: ENABLED_PAIR, infoById: {
      [CAMPAIGN]: { schedule_type: "FROM_NOW", schedule_start_time: "2026-11-06 00:00:00" }, [OTHER]: FUTURE } });
    await expect(h.read()).rejects.toMatchObject({ code: "MULTIPLE_ENABLED_CAMPAIGNS_REVIEW_REQUIRED" });
    expect(h.calls).toHaveLength(3);
  });
  it.each([{}, { ...EXPIRED, schedule_end_time: "2026-11-31 08:00:00" }])("fails closed on an unknown schedule in a multi-candidate account (%j)", async unknown => {
    const h = setup({ campaigns: ENABLED_PAIR, infoById: { [CAMPAIGN]: EXPIRED, [OTHER]: unknown } });
    await expect(h.read()).rejects.toMatchObject({ code: "MULTIPLE_ENABLED_CAMPAIGNS_REVIEW_REQUIRED" });
    expect(h.calls).toHaveLength(3);
  });
  it.each([
    { advertiser_id: "7646832328389263378" }, { campaign_id: CAMPAIGN }, { operation_status: "DISABLE" },
    { tiktok_account_id: "7646832328389263378" }, { identity_list: [{ identity_id: "foreign" }] },
  ])("does not discard a supposedly expired row without exact scope proof (%j)", async mismatch => {
    const h = setup({ campaigns: ENABLED_PAIR, infoById: { [CAMPAIGN]: FUTURE, [OTHER]: { ...EXPIRED, ...mismatch } } });
    await expect(h.read()).rejects.toMatchObject({ code: "CREATOR_IDENTITY_BINDING_UNVERIFIED" });
    expect(h.calls).toHaveLength(3);
  });
  it("bounds INFO fan-out without truncating a larger ENABLE inventory", async () => {
    const campaigns = [...ENABLED_PAIR, ...["1880857574137138", "1880857574137139"].map(campaign_id => ({ campaign_id, operation_status: "ENABLE" }))];
    const h = setup({ campaigns });
    await expect(h.read()).rejects.toMatchObject({ code: "MULTIPLE_ENABLED_CAMPAIGNS_REVIEW_REQUIRED" });
    expect(h.calls).toHaveLength(1);
  });
  it("does not retain a cached or in-flight campaign beyond its known schedule end", async () => {
    const h = setup({ now: "2026-11-06T07:59:59Z", info: EXPIRED });
    expect((await h.read()).campaign.campaignId).toBe(CAMPAIGN);
    h.setTime("2026-11-06T08:00:00Z");
    expect((await h.read()).campaign).toBeNull();
    expect(h.calls).toHaveLength(5);
    const boundary = setup({ now: "2026-11-06T07:59:59Z", timeAtReport: "2026-11-06T08:00:00Z", info: EXPIRED });
    expect(await boundary.read()).toMatchObject({ campaign: null, quality: { aggregateSpendComplete: false } });
  });
  it("represents no active campaign without falling back to historic data", async () => {
    const h = setup({ campaigns: [] }); expect((await h.read()).campaign).toBeNull(); expect(h.calls).toHaveLength(1);
  });
  it("does not interpret an unknown campaign status as no active campaign", async () => {
    await expect(setup({ campaigns: [{ campaign_id: CAMPAIGN }] }).read()).rejects.toMatchObject({ code: "CAMPAIGN_SCOPE_UNVERIFIED" });
  });
  it("rejects contradictory nonempty zero-page spend metadata", async () => {
    const value = await setup({ reportPagination: { total_page: 0 } }).read();
    expect(value.campaign.spendMinor).toBeNull(); expect(value.quality.spendError).toBe("SPEND_PAGINATION_UNVERIFIED");
  });
  it("empty or failed financial reports remain unavailable, not zero", async () => {
    for (const o of [{ report: [] }, { reportError: true }]) {
      const value = await setup(o).read(); expect(value.campaign.spendMinor).toBeNull(); expect(value.quality.aggregateSpendComplete).toBe(false);
      expect(JSON.stringify(value)).not.toContain(TOKEN);
    }
  });
  it("does not double-count duplicated report dimensions", async () => {
    const row = { dimensions: { campaign_id: CAMPAIGN, country_code: "TH", stat_time_day: "2026-11-06" }, metrics: { spend: "2.00" } };
    const value = await setup({ report: [row, row] }).read(); expect(value.campaign.spendMinor).toBeNull(); expect(value.quality.spendError).toBe("SPEND_DUPLICATE_ROW");
  });
  it("converts decimal money without floating point arithmetic", () => {
    expect(minor("2723.52")).toBe(272352); expect(minor(3000)).toBe(300000);
    for (const v of ["-1", "1e3", "1.001", "NaN", Number.NaN, Infinity]) expect(() => minor(v)).toThrow();
  });
});
