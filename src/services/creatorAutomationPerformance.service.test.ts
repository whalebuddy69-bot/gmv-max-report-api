import { describe, expect, it, vi } from "vitest";
import { createCreatorAutomationPerformance } from "./creatorAutomationPerformance.service";
import { CREATOR_BINDING } from "./creatorRead.service";

const DATE = "2040-02-04";
const CAMPAIGN = "9000000000000001";
const OTHER = "9000000000000002";
const TOKEN = "example-test-token-not-real";
const SCOPE = { reportingDate: DATE, campaignId: CAMPAIGN };
const NOW = "2040-02-04T02:05:00.000Z";

const row = (hour: string, metrics: Record<string, unknown>, campaign = CAMPAIGN, date = DATE) => ({
  dimensions: { campaign_id: campaign, stat_time_hour: `${date} ${hour}:00:00` },
  metrics,
});
const zero = () => ({
  cost: "0.00", all_shops_gross_revenue: "0.00", all_shops_orders: "0", all_shops_roi: "0.00", live_views: "0",
});
const active = () => ({
  cost: "12.34", all_shops_gross_revenue: "50.25", all_shops_orders: "3", all_shops_roi: "4.07", live_views: "11",
});
const payload = (list: unknown[], page: Record<string, unknown> = {}, code = 0) => ({
  code, data: { list, page_info: { page: 1, page_size: 100, total_number: list.length, total_page: 1, ...page } },
});
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const unavailable = { state: "unavailable", observedAt: null, series: [] };

function fixture(initial = NOW) {
  let time = Date.parse(initial);
  const loadToken = vi.fn(async () => TOKEN);
  const fetchImpl = vi.fn<typeof fetch>();
  const performance = createCreatorAutomationPerformance({ loadToken, fetchImpl, now: () => new Date(time) });
  return {
    performance, loadToken, fetchImpl,
    advance(ms: number) { time += ms; },
  };
}

describe("Ppan-only Creator hourly performance", () => {
  it("uses one scoped GET, converts exact money and preserves null vs zero", async () => {
    const f = fixture();
    f.fetchImpl.mockResolvedValueOnce(json(payload([
      row("23", zero()),
      row("07", { cost: "0", all_shops_gross_revenue: "0.00", live_views: "0", all_shops_roi: "0.00" }),
      row("09", active()),
      row("08", {}),
    ])));
    await expect(f.performance(SCOPE)).resolves.toEqual({
      state: "available",
      observedAt: NOW,
      series: [
        { hour: "07:00", spendMinor: 0, gmvMinor: 0, orders: null, roi: null, liveViews: 0 },
        { hour: "08:00", spendMinor: null, gmvMinor: null, orders: null, roi: null, liveViews: null },
        { hour: "09:00", spendMinor: 1234, gmvMinor: 5025, orders: 3, roi: 4.07, liveViews: 11 },
      ],
    });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = f.fetchImpl.mock.calls[0]!;
    expect(url).toBeInstanceOf(URL);
    const parsed = url as URL;
    expect(parsed.origin + parsed.pathname).toBe("https://business-api.tiktok.com/open_api/v1.3/gmv_max/report/get/");
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      advertiser_id: CREATOR_BINDING.advertiserId, store_ids: '["0"]', start_date: DATE, end_date: DATE,
      dimensions: '["campaign_id","stat_time_hour"]',
      metrics: '["cost","all_shops_orders","all_shops_gross_revenue","all_shops_roi","live_views"]',
      filtering: JSON.stringify({ gmv_max_promotion_types: ["LIVE"], campaign_ids: [CAMPAIGN], campaign_statuses: ["STATUS_ALL"] }),
      page: "1", page_size: "100",
    });
    expect(init).toMatchObject({ method: "GET", redirect: "error", headers: { "Access-Token": TOKEN, "Cache-Control": "no-cache" } });
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not fabricate activity from all-zero padding, no rows, or absent hours", async () => {
    const f = fixture();
    f.fetchImpl.mockResolvedValueOnce(json(payload(Array.from({ length: 24 }, (_, h) =>
      row(String(h).padStart(2, "0"), zero()),
    ))));
    await expect(f.performance(SCOPE)).resolves.toEqual({ state: "available", observedAt: NOW, series: [] });
    f.advance(180_000);
    f.fetchImpl.mockResolvedValueOnce(json(payload([], { total_page: 0 })));
    await expect(f.performance(SCOPE)).resolves.toEqual({ state: "available", observedAt: "2040-02-04T02:08:00.000Z", series: [] });
    f.advance(180_000);
    f.fetchImpl.mockResolvedValueOnce(json(payload([row("05", active()), row("09", { live_views: "1" })])));
    expect((await f.performance(SCOPE)).series.map(p => p.hour)).toEqual(["05:00", "09:00"]);
  });

  it.each([
    ["non-target campaign", payload([row("09", active(), OTHER)])],
    ["wrong report day", payload([row("09", active(), CAMPAIGN, "2040-02-03")])],
    ["unexpected hour", payload([row("24", active())])],
    ["duplicate hour", payload([row("09", active()), row("09", active())])],
    ["unexpected pagination", payload([row("09", active())], { total_page: 2 })],
    ["wrong total", payload([row("09", active())], { total_number: 2 })],
    ["wrong precision", payload([row("09", { cost: "1.001" })])],
    ["malformed metrics", payload([row("09", { live_views: TOKEN })])],
    ["fractional orders", payload([row("09", { all_shops_orders: "1.5" })])],
    ["provider refusal", payload([row("09", active())], {}, 40002)],
  ])("rejects %s without exposing partial rows or raw errors", async (_name, result) => {
    const f = fixture();
    f.fetchImpl.mockResolvedValueOnce(json(result));
    await expect(f.performance(SCOPE)).resolves.toEqual(unavailable);
  });

  it("bounds response size and does not leak provider errors", async () => {
    const f = fixture();
    f.fetchImpl.mockResolvedValueOnce(new Response("ignored", { headers: { "content-length": "600000" } }));
    await expect(f.performance(SCOPE)).resolves.toEqual(unavailable);
    f.advance(15_001);
    f.fetchImpl.mockResolvedValueOnce(new Response("x".repeat(513 * 1024)));
    await expect(f.performance(SCOPE)).resolves.toEqual(unavailable);
    f.advance(15_001);
    f.fetchImpl.mockRejectedValueOnce(new Error(TOKEN));
    await expect(f.performance(SCOPE)).resolves.toEqual(unavailable);
  });

  it("checks the Bangkok reporting date before calling and after receiving", async () => {
    const f = fixture("2040-02-04T16:59:59.000Z");
    const prev = { ...SCOPE, reportingDate: "2040-02-03" };
    await expect(f.performance(prev)).resolves.toEqual(unavailable);
    await expect(f.performance({ ...SCOPE, campaignId: "0" })).resolves.toEqual(unavailable);
    expect(f.loadToken).not.toHaveBeenCalled();
    f.fetchImpl.mockImplementationOnce(async () => {
      f.advance(1_000);
      return json(payload([row("09", active())]));
    });
    await expect(f.performance(SCOPE)).resolves.toEqual(unavailable);
    await expect(f.performance(SCOPE)).resolves.toEqual(unavailable);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("coalesces same-scope calls, isolates another campaign, and never substitutes stale data on failure", async () => {
    const f = fixture();
    let resolve!: (response: Response) => void;
    f.fetchImpl.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const first = f.performance(SCOPE);
    const parallel = f.performance(SCOPE);
    await expect(f.performance({ ...SCOPE, campaignId: OTHER })).resolves.toEqual(unavailable);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    resolve(json(payload([row("09", active())])));
    const available = await first;
    expect(available.observedAt).toBe(NOW);
    expect(await parallel).toEqual(available);
    f.advance(179_999);
    expect(await f.performance(SCOPE)).toEqual(available);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    f.advance(1);
    f.fetchImpl.mockRejectedValueOnce(new Error("unavailable"));
    await expect(f.performance(SCOPE)).resolves.toEqual(unavailable);
    await expect(f.performance(SCOPE)).resolves.toEqual(unavailable);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    f.fetchImpl.mockResolvedValueOnce(json(payload([row("08", { live_views: "1" }, OTHER)])));
    expect((await f.performance({ ...SCOPE, campaignId: OTHER })).series[0]?.hour).toBe("08:00");
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
  });
});
