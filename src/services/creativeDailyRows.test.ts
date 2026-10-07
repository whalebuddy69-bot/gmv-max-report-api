import { describe, expect, it } from "vitest";
import { toCreativeRows } from "./creativeDailyRows";
import type { MetricValue, ReportRow, StoreContext } from "./tiktokApi.service";

const ctx: StoreContext = { advertiserId: "advertiser", storeId: "store", storeAuthorizedBcId: "bc" };
const pair = { campaignId: "campaign", itemGroupId: "product" };
const syncedAt = new Date("2026-10-07T03:00:00Z");
const source = (metrics: Record<string, MetricValue> = {}): ReportRow => ({
  dimensions: { item_id: "7582163856857006081", stat_time_day: "2026-10-06 00:00:00" },
  metrics,
});
const map = (rows: ReportRow[]) => toCreativeRows(rows, ctx, pair, syncedAt);

describe("toCreativeRows", () => {
  it.each([0, "0"])("preserves an awaiting-delivery video with zero metrics (%s)", (zero) => {
    const [row] = map([source({ cost: zero, orders: zero, product_impressions: zero, creative_delivery_status: "LEARNING", shop_content_type: "VIDEO" })]);
    expect(row).toMatchObject({
      ...pair, advertiserId: "advertiser", storeId: "store", itemId: "7582163856857006081",
      statDate: "2026-10-06", cost: 0, orders: 0, productImpressions: 0,
      creativeDeliveryStatus: "LEARNING", shopContentType: "VIDEO", syncedAt,
    });
  });

  it.each([undefined, null, "", " ", "-", "invalid", Number.NaN, Number.POSITIVE_INFINITY])(
    "keeps missing or invalid metrics unknown, not synthetic zero (%s)", (value) => {
      const metrics = value === undefined ? {} : { cost: value, orders: value, product_impressions: value };
      const [row] = map([source(metrics)]);
      expect(row).toMatchObject({ cost: null, orders: null, productImpressions: null, creativeDeliveryStatus: null, title: null });
    },
  );

  it("preserves valid rows even when the metrics object is absent", () => {
    const { dimensions } = source();
    const [row] = map([{ dimensions }]);
    expect(row).toMatchObject({ cost: null, orders: null, grossRevenue: null });
  });

  it("preserves a zero-activity product card without converting -1 to null", () => {
    const input = source({ shop_content_type: "PRODUCT_CARD", cost: 0, orders: 0, product_impressions: 0 });
    input.dimensions!.item_id = "-1";
    expect(map([input])).toEqual([expect.objectContaining({ itemId: "-1", shopContentType: "PRODUCT_CARD", cost: 0 })]);
  });

  it.each([undefined, null, "", " ", "0", 0, "-2", "-", "abc", "1.5", Number.NaN, 7582163856857006081])(
    "rejects invalid or precision-lost item IDs (%s)", (value) => {
      const input = source();
      if (value === undefined) delete input.dimensions!.item_id;
      else input.dimensions!.item_id = value;
      expect(map([input])).toEqual([]);
    },
  );

  it.each([undefined, null, "", "2026-02-30", "2026-02-29", "2026-13-01", "2026-10-00", "2026-1-6", "2026-10-06invalid", "not a date", 20261006])(
    "rejects missing or invalid report dates without inventing a day (%s)", (value) => {
      const input = source();
      if (value === undefined) delete input.dimensions!.stat_time_day;
      else input.dimensions!.stat_time_day = value;
      expect(map([input])).toEqual([]);
    },
  );

  it.each(["2024-02-29", "2026-10-06", "2026-10-06 00:00:00", "2026-10-06T00:00:00+07:00"])(
    "preserves the source reporting day without timezone shifting (%s)", (day) => {
      const input = source();
      input.dimensions!.stat_time_day = day;
      expect(map([input])[0].statDate).toBe(day.slice(0, 10));
    },
  );

  it("preserves every financial and engagement metric without recalculating or inflating it", () => {
    const [row] = map([source({
      cost: "123.45", orders: "3", cost_per_order: "41.15", gross_revenue: "999.75", roi: "8.0984",
      product_impressions: "1234", product_clicks: "51", product_click_rate: "0.0413", ad_click_rate: "0.033",
      ad_conversion_rate: "0.1", ad_video_view_rate_2s: "0.8", ad_video_view_rate_6s: "0.7",
      ad_video_view_rate_p25: "0.6", ad_video_view_rate_p50: "0.5", ad_video_view_rate_p75: "0.4", ad_video_view_rate_p100: "0.3",
      title: "Video title", tt_account_name: "Creator name", tt_account_authorization_type: "AFFILIATE",
      tt_account_profile_image_url: "https://example.test/avatar.png", shop_content_type: "VIDEO", creative_delivery_status: "DELIVERING",
    })]);
    expect(row).toMatchObject({
      cost: 123.45, orders: 3, costPerOrder: 41.15, grossRevenue: 999.75, roi: 8.0984,
      productImpressions: 1234, productClicks: 51, productClickRate: 0.0413, adClickRate: 0.033,
      adConversionRate: 0.1, viewRate2s: 0.8, viewRate6s: 0.7, viewRateP25: 0.6, viewRateP50: 0.5, viewRateP75: 0.4, viewRateP100: 0.3,
      title: "Video title", ttAccountName: "Creator name", ttAccountAuthorizationType: "AFFILIATE",
      ttAccountProfileImageUrl: "https://example.test/avatar.png", shopContentType: "VIDEO", creativeDeliveryStatus: "DELIVERING",
    });
  });

  it("does not discard revenue-only or adjustment rows", () => {
    const rows = map([
      source({ cost: 0, orders: 0, product_impressions: 0, gross_revenue: "175.50" }),
      source({ cost: "-10.25", orders: 0, product_impressions: 0, gross_revenue: "-25.50" }),
    ]);
    expect(rows.map(({ cost, grossRevenue }) => ({ cost, grossRevenue }))).toEqual([
      { cost: 0, grossRevenue: 175.5 }, { cost: -10.25, grossRevenue: -25.5 },
    ]);
  });

  it("does not synthesize rows, copy statuses, or fabricate missing dates", () => {
    const input = source({ creative_delivery_status: "LEARNING", title: "0", tt_account_name: "-1" });
    const rows = map([input, { metrics: { creative_delivery_status: "DELIVERING" } }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ creativeDeliveryStatus: "LEARNING", title: null, ttAccountName: null });
    expect(map([])).toEqual([]);
  });
});
