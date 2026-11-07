import { describe, expect, it, vi } from "vitest";
import { CREATOR_BINDING } from "./creatorRead.service";
vi.mock("../routes/creatorRead.route", () => ({ createExtraCreatorTokenLoader: () => { throw new Error("unexpected DB dependency"); } }));
import { createVerifiedExtraCreatorReadAdapter } from "./creatorAutomationExtraRead.service";

const TEST = Object.freeze({ clientId: "synthetic_extra", advertiserId: "9123456789012345678", tiktokAccountId: "9234567890123456789",
  identityId: "example-bc-identity", identityType: "BC_AUTH_TT" as const, identityAuthorizedBcId: "9345678901234567890" });
const CAMPAIGN = "9456789012345678901", TOKEN = "only-used-in-local-test-fetch", TODAY = "2026-11-07";
const NOW = new Date(`${TODAY}T09:30:00.000Z`);

function setup(overrides: { advertiser?: Record<string, unknown>; info?: Record<string, unknown>; listCount?: number;
  noActive?: boolean; mismatchedReportAdvertiser?: boolean; mismatchedSpendAdvertiser?: boolean; secondEnabled?: boolean } = {}) {
  const calls: URL[] = [];
  const loadToken = vi.fn(async () => TOKEN);
  const active = { advertiser_id: TEST.advertiserId, campaign_id: CAMPAIGN, operation_status: "ENABLE" };
  const fetchImpl = vi.fn(async (input, init) => {
    const url = new URL(input); calls.push(url);
    expect(url.origin).toBe("https://business-api.tiktok.com");
    expect(init.method).toBe("GET"); expect(init.redirect).toBe("error");
    expect(init.headers["Access-Token"]).toBe(TOKEN);
    expect(url.searchParams.has("store_id")).toBe(false);
    let data;
    if (url.pathname.endsWith("/advertiser/info/")) {
      expect(url.searchParams.get("advertiser_ids")).toBe(JSON.stringify([TEST.advertiserId]));
      data = { list: [{ advertiser_id: TEST.advertiserId, currency: "THB", timezone: "Asia/Bangkok", ...overrides.advertiser }] };
    } else {
      expect(url.searchParams.get("advertiser_id")).toBe(TEST.advertiserId);
      if (url.pathname.endsWith("/gmv_max/campaign/get/")) {
        const page = Number(url.searchParams.get("page")), count = overrides.listCount ?? 1;
        const total_page = Math.ceil(count / 100), list = [];
        for (let index = (page - 1) * 100; index < Math.min(page * 100, count); index++) {
          if (!overrides.noActive && (index === 0 || (overrides.secondEnabled && index === count - 1))) {
            list.push(index === 0 ? active : { ...active, campaign_id: "9567890123456789012" });
          } else {
            list.push({ advertiser_id: TEST.advertiserId, campaign_id: `989999${String(index).padStart(12, "0")}`, operation_status: "DISABLE" });
          }
        }
        data = { list, page_info: { page, total_page, total_number: count } };
      } else if (url.pathname.endsWith("/campaign/gmv_max/info/")) {
        expect(url.searchParams.get("campaign_id")).toBe(CAMPAIGN);
        data = { ...active, campaign_name: "Synthetic read", shopping_ads_type: "LIVE", budget: 1200, roas_bid: 9,
          store_id: "0", store_authorized_bc_id: "0", identity_list: [{ identity_id: TEST.identityId,
            identity_type: TEST.identityType, identity_authorized_bc_id: TEST.identityAuthorizedBcId }], ...overrides.info };
      } else if (url.pathname.endsWith("/report/integrated/get/")) {
        data = { advertiser_id: overrides.mismatchedSpendAdvertiser ? CREATOR_BINDING.advertiserId : TEST.advertiserId,
          list: [{ dimensions: { campaign_id: CAMPAIGN, stat_time_day: `${TODAY} 00:00:00`, country_code: "TH" },
          metrics: { spend: "501.25" } }], page_info: { page: 1, total_page: 1, total_number: 1 } };
      } else {
        expect(url.pathname.endsWith("/gmv_max/report/get/")).toBe(true);
        expect(url.searchParams.get("store_ids")).toBe('["0"]');
        expect(JSON.parse(url.searchParams.get("filtering") ?? "").campaign_ids).toEqual([CAMPAIGN]);
        data = { advertiser_id: overrides.mismatchedReportAdvertiser ? CREATOR_BINDING.advertiserId : TEST.advertiserId,
          list: [{ dimensions: { campaign_id: CAMPAIGN, stat_time_hour: `${TODAY} 08:00:00` },
            metrics: { cost: "20.30", all_shops_gross_revenue: "50.00", all_shops_orders: "2", all_shops_roi: "2.46", live_views: "35" } }],
          page_info: { page: 1, total_page: 1, total_number: 1 } };
      }
    }
    return Response.json({ code: 0, data });
  }) as unknown as typeof fetch;
  const adapter = createVerifiedExtraCreatorReadAdapter(TEST, { loadToken, fetchImpl, now: () => NOW, sleep: async () => {} });
  return { adapter, calls, loadToken };
}

describe("private, advertiser-bound extra Creator reads", () => {
  it("checks the advertiser currency/timezone, all five pages, and the scoped identity before reads", async () => {
    const h = setup({ listCount: 430 }), value = await h.adapter.readSnapshot();
    expect(h.adapter.tiktokAccountIdVerified).toBe(false);
    expect(value).toMatchObject({ clientId: TEST.clientId, readOnly: true,
      binding: { advertiserId: TEST.advertiserId, identityId: TEST.identityId },
      campaign: { campaignId: CAMPAIGN, currency: "THB", spendMinor: 50125 },
      capabilities: { read: true, budgetWrite: false, autoOptimization: false } });
    expect(h.calls).toHaveLength(8); expect(h.calls[0].pathname.endsWith("/advertiser/info/")).toBe(true);
    expect(h.loadToken).toHaveBeenCalledTimes(1); expect(JSON.stringify(value)).not.toContain(TOKEN);
  });

  it("does not fetch performance for a foreign or previous-day campaign", async () => {
    const h = setup();
    await expect(h.adapter.readPerformance({ campaignId: "9567890123456789012", reportingDate: TODAY })).resolves.toMatchObject({ state: "unavailable" });
    await expect(h.adapter.readPerformance({ campaignId: CAMPAIGN, reportingDate: "2026-11-06" })).resolves.toMatchObject({ state: "unavailable" });
    expect(h.calls.some(x => x.pathname.endsWith("/gmv_max/report/get/"))).toBe(false);
    await expect(h.adapter.readPerformance({ campaignId: CAMPAIGN, reportingDate: TODAY })).resolves.toMatchObject({ state: "available", series: [{
      hour: "08:00", spendMinor: 2030, gmvMinor: 5000, orders: 2, roi: 2.46, liveViews: 35 }] });
    expect(h.calls.filter(x => x.pathname.endsWith("/gmv_max/report/get/"))).toHaveLength(1);
  });

  it("rejects mismatched currency, advertiser or day boundary metadata before reading campaigns", async () => {
    for (const advertiser of [{ currency: "USD" }, { timezone: "UTC" }, { advertiser_id: CREATOR_BINDING.advertiserId }]) {
      const h = setup({ advertiser });
      await expect(h.adapter.readSnapshot()).rejects.toMatchObject({ code: "CREATOR_ADVERTISER_SCOPE_UNVERIFIED" });
      expect(h.calls).toHaveLength(1);
    }
  });

  it("does not read spend for a Shop or another BC identity", async () => {
    for (const info of [{ store_id: "9111111111111111111" },
      { identity_list: [{ identity_id: TEST.identityId, identity_type: TEST.identityType, identity_authorized_bc_id: "9333333333333333333" }] }]) {
      const h = setup({ info });
      await expect(h.adapter.readSnapshot()).rejects.toMatchObject({ code: "CREATOR_IDENTITY_BINDING_UNVERIFIED" });
      expect(h.calls).toHaveLength(3);
    }
  });

  it("checks later pages before asserting a single enabled campaign", async () => {
    const h = setup({ listCount: 430, secondEnabled: true });
    await expect(h.adapter.readSnapshot()).rejects.toMatchObject({ code: "MULTIPLE_ENABLED_CAMPAIGNS_REVIEW_REQUIRED" });
    expect(h.calls).toHaveLength(6);
  });

  it("filters foreign advertiser output from the hourly report and no-active snapshots", async () => {
    await expect(setup({ mismatchedReportAdvertiser: true }).adapter.readPerformance({ campaignId: CAMPAIGN, reportingDate: TODAY }))
      .resolves.toMatchObject({ state: "unavailable", series: [] });
    const inactive = setup({ noActive: true });
    await expect(inactive.adapter.readPerformance({ campaignId: CAMPAIGN, reportingDate: TODAY })).resolves.toMatchObject({ state: "unavailable" });
    expect(inactive.calls).toHaveLength(2);
  });

  it("never turns foreign advertiser spend into zero or uses the supplied account number as proof", async () => {
    const h = setup({ mismatchedSpendAdvertiser: true, info: { tiktok_account_id: "9222222222222222222" } });
    await expect(h.adapter.readSnapshot()).resolves.toMatchObject({ campaign: { campaignId: CAMPAIGN, spendMinor: null },
      quality: { aggregateSpendComplete: false, aggregateSpendMinor: null, spendError: "SPEND_SCOPE_UNVERIFIED" } });
  });

  it("cannot alias the existing Ppan advertiser, account ID, identity or slug", () => {
    for (const patch of [{ clientId: "punpan_020" }, { advertiserId: CREATOR_BINDING.advertiserId },
      { tiktokAccountId: CREATOR_BINDING.tiktokAccountId }, { identityId: CREATOR_BINDING.identityId }]) {
      expect(() => createVerifiedExtraCreatorReadAdapter({ ...TEST, ...patch }, { loadToken: async () => TOKEN })).toThrow();
    }
  });
});
