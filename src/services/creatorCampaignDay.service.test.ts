import { describe, expect, it, vi } from "vitest";
import { createCreatorCampaignDayReader } from "./creatorCampaignDay.service";
import { CREATOR_BINDING } from "./creatorRead.service";

const DAY = "2026-11-08", AT = `${DAY}T07:00:00.000Z`, TOKEN = "fixture-do-not-expose-token";
const ACTIVE = "9000000000001", PAUSED = "9000000000002", ZERO = "9000000000003", OTHER = "9000000000004";
const b = CREATOR_BINDING;
const status = (campaign_id: string, operation_status = "DISABLE") => ({ advertiser_id: b.advertiserId, campaign_id, operation_status });
const row = (campaign_id: string, cost = "10.50", gmv = "42.00", views = 2) => ({
  dimensions: { campaign_id, stat_time_day: `${DAY} 00:00:00`, store_id: "0" },
  metrics: { cost, all_shops_gross_revenue: gmv, all_shops_orders: 0, live_views: views },
});
const page = (list: unknown[], page = 1, total_page = 1, total_number = list.length) => ({ list, page_info: { page, total_page, total_number, page_size: 100 } });
const detail = (id: string, operation = "DISABLE") => ({ ...status(id, operation),
  shopping_ads_type: "LIVE", store_id: "0", store_authorized_bc_id: "0", campaign_name: `Synthetic ${id}`,
  identity_list: [{ identity_id: b.identityId, identity_type: b.identityType, identity_authorized_bc_id: b.identityAuthorizedBcId }],
  budget: "100.00", roas_bid: 2.3, schedule_type: "SCHEDULE_FROM_NOW", schedule_start_time: `${DAY} 00:00:00`,
});

function setup({ list, report, info, metadata }: {
  list?: (url: URL) => unknown; report?: (url: URL) => unknown; info?: (id: string) => unknown; metadata?: unknown;
} = {}) {
  let time = new Date(AT);
  const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
    expect(url.origin).toBe("https://business-api.tiktok.com");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("Access-Token")).toBe(TOKEN);
    let data: unknown;
    if (url.pathname.endsWith("/advertiser/info/")) data = metadata ?? { list: [{ advertiser_id: b.advertiserId, currency: "THB", timezone: "Asia/Bangkok" }] };
    else {
      expect(url.searchParams.get("advertiser_id")).toBe(b.advertiserId);
      if (url.pathname.endsWith("/gmv_max/campaign/get/")) data = list ? list(url) : page([status(ACTIVE, "ENABLE"), status(PAUSED), status(ZERO)]);
      else if (url.pathname.endsWith("/gmv_max/report/get/")) data = report ? report(url) : page([row(PAUSED), row(ZERO, "0", "0", 0)]);
      else {
        expect(url.pathname.endsWith("/campaign/gmv_max/info/")).toBe(true);
        const id = url.searchParams.get("campaign_id")!;
        data = info ? info(id) : detail(id, id === ACTIVE ? "ENABLE" : "DISABLE");
      }
    }
    return Response.json({ code: data === null ? 40001 : 0, data });
  });
  const read = createCreatorCampaignDayReader({ fetchImpl: fetchImpl as unknown as typeof fetch,
    loadToken: async () => TOKEN, now: () => time, sleep: async () => {} }, b);
  return { read, fetchImpl, setNow: (next: string) => { time = new Date(next); } };
}

describe("Creator same-day campaign reader", () => {
  it("includes an enabled campaign with unknown metrics, a verified paused campaign with activity, and omits zero inactive rows", async () => {
    const h = setup();
    const got = await h.read();
    expect(got).toMatchObject({ reportingDate: DAY, observedAt: AT, coverage: "complete", campaigns: [
      { campaignId: ACTIVE, operationStatus: "ENABLE", spendMinor: null, roi: null, activityToday: false },
      { campaignId: PAUSED, operationStatus: "DISABLE", spendMinor: 1050, gmvMinor: 4200, roi: 4, targetRoi: 2.3,
        activityToday: true, dailyBudgetMinor: 10000, scheduleStartAt: `${DAY}T00:00:00.000Z`, scheduleEndAt: null },
    ] });
    const [reportUrl] = h.fetchImpl.mock.calls[2];
    expect(Object.fromEntries(reportUrl.searchParams)).toEqual({ advertiser_id: b.advertiserId, store_ids: '["0"]', start_date: DAY, end_date: DAY,
      dimensions: '["campaign_id","stat_time_day"]', metrics: '["cost","all_shops_gross_revenue","all_shops_orders","live_views"]',
      filtering: '{"gmv_max_promotion_types":["LIVE"],"campaign_statuses":["STATUS_ALL"]}', page: "1", page_size: "100" });
    expect(h.fetchImpl.mock.calls.some(([url]) => url.searchParams.get("campaign_id") === ZERO)).toBe(false);
    expect(h.fetchImpl.mock.calls).toHaveLength(5);
  });

  it("paginates report and list and retains exact activity-only rows without making up a zero or ROI", async () => {
    const h = setup({ list: url => Number(url.searchParams.get("page")) === 1 ? page([status(ACTIVE, "ENABLE")], 1, 2, 2) : page([status(PAUSED)], 2, 2, 2),
      report: url => Number(url.searchParams.get("page")) === 1 ? page([row(ACTIVE, "0", "0", 0)], 1, 2, 2) : page([row(PAUSED, "0", "0", 3)], 2, 2, 2) });
    const got = await h.read();
    expect(got.coverage).toBe("complete");
    expect(got.campaigns).toHaveLength(2);
    expect(got.campaigns[1]).toMatchObject({ campaignId: PAUSED, activityToday: true, spendMinor: 0, roi: null });
  });

  it("never exposes foreign identities, Shop campaigns, or provider errors", async () => {
    const h = setup({ report: () => page([row(OTHER), row(PAUSED)]), info: id => id === ACTIVE ? { ...detail(id, "ENABLE"), store_id: OTHER }
      : id === PAUSED ? { ...detail(id), campaign_name: `Safe ${TOKEN}` }
        : { ...detail(id), identity_list: [{ ...detail(id).identity_list[0], identity_id: "foreign-identity" }] } });
    const got = await h.read();
    expect(got.coverage).toBe("complete");
    expect(got.campaigns).toHaveLength(1);
    expect(got.campaigns[0]).toMatchObject({ campaignId: PAUSED, campaignName: "Safe [REDACTED]" });
    expect(JSON.stringify(got)).not.toContain(TOKEN);
  });

  it.each([null, page([row(PAUSED), row(PAUSED)]), page([{ ...row(PAUSED), dimensions: { ...row(PAUSED).dimensions, stat_time_day: "2026-11-07" } }])])(
    "keeps only verified current campaigns with partial coverage when the daily report cannot be trusted", async report => {
      const h = setup({ report: () => report });
      const got = await h.read();
      expect(got).toMatchObject({ coverage: "partial", campaigns: [{ campaignId: ACTIVE, spendMinor: null, roi: null }] });
    });

  it("fails closed if account currency or timezone cannot be verified", async () => {
    const h = setup({ metadata: { list: [{ advertiser_id: b.advertiserId, currency: "USD", timezone: "Asia/Bangkok" }] } });
    expect(await h.read()).toEqual({ coverage: "unavailable", reportingDate: DAY, campaigns: [], observedAt: null });
    expect(h.fetchImpl.mock.calls).toHaveLength(1);
  });

  it("coalesces the same scoped day and never carries yesterday's campaign evidence across Bangkok midnight", async () => {
    const h = setup({ list: () => page([]), report: () => page([]) });
    await Promise.all([h.read(), h.read(), h.read()]);
    await h.read();
    expect(h.fetchImpl.mock.calls).toHaveLength(3);
    h.setNow("2026-11-08T17:00:00.000Z");
    expect(await h.read()).toMatchObject({ coverage: "complete", reportingDate: "2026-11-09" });
    expect(h.fetchImpl.mock.calls).toHaveLength(6);
  });
});
