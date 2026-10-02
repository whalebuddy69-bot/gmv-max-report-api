import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../db/dataSource", () => ({
  AppDataSource: { query: (...args: unknown[]) => queryMock(...args) },
}));

import {
  campaigns,
  creators,
  creatives,
  dailyAllMetrics,
  dailyContentStats,
  listCampaignOptions,
  listCreatorOptions,
  liveRooms,
  products,
  summary,
  timeseries,
} from "./analytics.service";

function sqlOf(callIndex = 0): string {
  return queryMock.mock.calls[callIndex][0] as string;
}
function paramsOf(callIndex = 0): unknown[] {
  return queryMock.mock.calls[callIndex][1] as unknown[];
}

const baseFilter = { from: "2026-08-01", to: "2026-08-31" };

describe("creative username enrichment", () => {
  it("adds verified metadata after aggregation without changing totals or row count", async () => {
    const id = "7683142323382832402";
    queryMock.mockResolvedValueOnce([{ total: "2" }]);
    queryMock.mockResolvedValueOnce([
      { item_id: id, tt_account_name: "Su Pyae", cost: "123.45", orders: "4" },
      { item_id: "-1", tt_account_name: null, cost: "10", orders: "1" },
    ]);
    queryMock.mockResolvedValueOnce([{ item_id: id, username: "khaingsupyae999", posted_at: null, posted_at_source: null }]);
    const result = await creatives({ ...baseFilter, storeIds: ["7495637369664014736"] });
    expect(result.total).toBe(2);
    expect(result.rows).toEqual([
      { item_id: id, tt_account_name: "Su Pyae", cost: 123.45, orders: 4, tt_account_username: "khaingsupyae999", video_posted_at: null, video_posted_at_source: null },
      { item_id: "-1", tt_account_name: null, cost: 10, orders: 1, tt_account_username: null, video_posted_at: null, video_posted_at_source: null },
    ]);
    expect(queryMock.mock.calls[2][1]).toEqual([[id]]);
  });
});

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue([{}]);
});

describe("campaign-level promotionType filtering", () => {
  it("listCampaignOptions defaults to PRODUCT when promotionType is omitted", async () => {
    await listCampaignOptions(baseFilter);
    expect(sqlOf()).toContain("promotion_type = $");
    expect(paramsOf()).toContain("PRODUCT");
  });

  it("listCampaignOptions filters to LIVE only when asked", async () => {
    await listCampaignOptions({ ...baseFilter, promotionType: "LIVE" });
    expect(sqlOf()).toContain("promotion_type = $");
    expect(paramsOf()).toContain("LIVE");
    expect(paramsOf()).not.toContain("PRODUCT");
  });

  it("promotionType=ALL adds no promotion_type clause or bound value at all", async () => {
    await listCampaignOptions({ ...baseFilter, promotionType: "ALL" });
    expect(sqlOf()).not.toContain("promotion_type");
    expect(paramsOf()).not.toContain("PRODUCT");
    expect(paramsOf()).not.toContain("LIVE");
  });

  it("summary scopes both the current AND previous period to the same promotionType", async () => {
    await summary({ ...baseFilter, promotionType: "LIVE" });

    // 2 queries per period (campaign + content); the campaign queries are calls 0 and 1
    expect(queryMock).toHaveBeenCalledTimes(4);
    expect(sqlOf(0)).toContain("promotion_type = $");
    expect(sqlOf(1)).toContain("promotion_type = $");
    expect(paramsOf(0)).toContain("LIVE");
    expect(paramsOf(1)).toContain("LIVE");
  });

  it("summary defaults both periods to PRODUCT when promotionType is omitted", async () => {
    await summary(baseFilter);

    expect(paramsOf(0)).toContain("PRODUCT");
    expect(paramsOf(1)).toContain("PRODUCT");
  });

  it("timeseries binds promotionType the same way", async () => {
    await timeseries({ ...baseFilter, promotionType: "LIVE" });
    expect(sqlOf()).toContain("promotion_type = $");
    expect(paramsOf()).toContain("LIVE");
  });

  it("campaigns() selects promotion_type per row and binds the filter", async () => {
    await campaigns({ ...baseFilter, promotionType: "LIVE" });
    expect(sqlOf()).toContain("promotion_type");
    expect(sqlOf()).toMatch(/max\(promotion_type\) AS promotion_type/);
    expect(paramsOf()).toContain("LIVE");
  });

  it("campaigns() with promotionType=ALL returns both types unfiltered", async () => {
    await campaigns({ ...baseFilter, promotionType: "ALL" });
    // Still selects the column (so rows can be labeled), just no WHERE-clause filter.
    expect(sqlOf()).toMatch(/max\(promotion_type\) AS promotion_type/);
    expect(sqlOf()).not.toMatch(/WHERE[\s\S]*promotion_type = \$/);
  });
});

describe("tables with no promotion_type column are never filtered by it", () => {
  it("products() never mentions promotion_type", async () => {
    await products(baseFilter);
    expect(sqlOf()).not.toContain("promotion_type");
  });

  it("creators() never mentions promotion_type", async () => {
    await creators(baseFilter);
    expect(sqlOf()).not.toContain("promotion_type");
  });

  it("liveRooms() never mentions promotion_type", async () => {
    await liveRooms(baseFilter);
    expect(sqlOf()).not.toContain("promotion_type");
  });
});

describe("liveRooms()", () => {
  it("reads report_live_room_daily, grouped per room", async () => {
    await liveRooms(baseFilter);
    expect(sqlOf()).toContain("FROM report_live_room_daily");
    expect(sqlOf()).toContain("GROUP BY store_id, campaign_id, room_id");
  });

  it("recomputes ratios from summed numerator/denominator rather than summing a stored ratio", async () => {
    await liveRooms(baseFilter);
    expect(sqlOf()).toMatch(/CASE WHEN sum\(cost\) > 0 THEN sum\(gross_revenue\)\/sum\(cost\) END AS roi/);
    expect(sqlOf()).toMatch(/CASE WHEN sum\(live_views\) > 0 THEN sum\(cost\)\/sum\(live_views\) END AS cost_per_live_view/);
    // Never a bare sum(roi) or sum(cost_per_live_view), that would sum daily ratios.
    expect(sqlOf()).not.toMatch(/sum\(roi\)/);
    expect(sqlOf()).not.toMatch(/sum\(cost_per_live_view\)/);
  });

  it("scopes to one campaign when campaignId is given, as a bound parameter", async () => {
    await liveRooms({ ...baseFilter, campaignId: "c1" });
    expect(sqlOf()).toContain("campaign_id = $");
    expect(paramsOf()).toContain("c1");
  });
});

describe("liveRooms() derived timing (start_date/start_time/end_time/duration_seconds)", () => {
  it("splits live_launched_time and adds live_duration to get end_time, same day", async () => {
    queryMock.mockResolvedValueOnce([
      { live_launched_time: "2026-09-03 01:01:44", live_duration: "3h 7m" },
    ]);

    const [row] = (await liveRooms(baseFilter)) as Record<string, unknown>[];

    expect(row.start_date).toBe("2026-09-03");
    expect(row.start_time).toBe("01:01:44");
    expect(row.duration_seconds).toBe(3 * 3600 + 7 * 60);
    expect(row.end_time).toBe("2026-09-03 04:08:44");
  });

  it("rolls end_time over to the next day when the room crosses midnight", async () => {
    queryMock.mockResolvedValueOnce([
      { live_launched_time: "2026-09-03 23:07:48", live_duration: "6h 6m" },
    ]);

    const [row] = (await liveRooms(baseFilter)) as Record<string, unknown>[];

    expect(row.end_time).toBe("2026-09-04 05:13:48");
  });

  it("handles TikTok's own un-normalised minutes (e.g. '3h 60m') the same as 4h 0m", async () => {
    queryMock.mockResolvedValueOnce([
      { live_launched_time: "2026-09-02 10:02:06", live_duration: "3h 60m" },
    ]);

    const [row] = (await liveRooms(baseFilter)) as Record<string, unknown>[];

    expect(row.duration_seconds).toBe(4 * 3600);
    expect(row.end_time).toBe("2026-09-02 14:02:06");
  });

  it("returns nulls for every derived field, not a throw, when duration is missing (e.g. an ONGOING room)", async () => {
    queryMock.mockResolvedValueOnce([
      { live_launched_time: "2026-09-05 09:00:00", live_duration: null },
    ]);

    const [row] = (await liveRooms(baseFilter)) as Record<string, unknown>[];

    expect(row.start_date).toBe("2026-09-05");
    expect(row.start_time).toBe("09:00:00");
    expect(row.duration_seconds).toBeNull();
    expect(row.end_time).toBeNull();
  });

  it("returns nulls for every derived field when launched_time itself doesn't parse", async () => {
    queryMock.mockResolvedValueOnce([{ live_launched_time: null, live_duration: "3h 7m" }]);

    const [row] = (await liveRooms(baseFilter)) as Record<string, unknown>[];

    expect(row.start_date).toBeNull();
    expect(row.start_time).toBeNull();
    expect(row.end_time).toBeNull();
    // duration_seconds is independent of launched_time and still parses on its own.
    expect(row.duration_seconds).toBe(3 * 3600 + 7 * 60);
  });
});

describe("identityId filtering", () => {
  it("campaigns() without identityId: no identity_id clause or bound value", async () => {
    await campaigns(baseFilter);
    expect(sqlOf()).not.toMatch(/WHERE[\s\S]*identity_id = \$/);
    expect(paramsOf()).not.toContain("identity-1");
  });

  it("campaigns() always selects identity_id/tt_account_name/tt_account_profile_image_url, identityId or not", async () => {
    await campaigns(baseFilter);
    expect(sqlOf()).toMatch(/max\(identity_id\) AS identity_id/);
    expect(sqlOf()).toMatch(/max\(tt_account_name\) AS tt_account_name/);
    expect(sqlOf()).toMatch(/max\(tt_account_profile_image_url\) AS tt_account_profile_image_url/);
  });

  it("campaigns() with identityId binds it as a parameter, not interpolated", async () => {
    await campaigns({ ...baseFilter, identityId: "identity-1" });
    expect(sqlOf()).toMatch(/identity_id = \$\d+/);
    expect(paramsOf()).toContain("identity-1");
    expect(sqlOf()).not.toContain("identity-1"); // never spliced into the SQL text itself
  });

  it("liveRooms() without identityId: no campaign_id-via-identity subquery", async () => {
    await liveRooms(baseFilter);
    expect(sqlOf()).not.toContain("report_campaign_daily");
  });

  it("liveRooms() with identityId filters via a subquery against report_campaign_daily, bound", async () => {
    await liveRooms({ ...baseFilter, identityId: "identity-1" });
    expect(sqlOf()).toMatch(
      /campaign_id IN \(\s*SELECT campaign_id FROM report_campaign_daily\s*WHERE identity_id = \$\d+ AND stat_date BETWEEN \$1 AND \$2\s*\)/
    );
    expect(paramsOf()).toContain("identity-1");
    expect(sqlOf()).not.toContain("identity-1");
  });

  it("an identityId that matches nothing is just an empty result, not an error", async () => {
    queryMock.mockResolvedValueOnce([]);
    const rows = await campaigns({ ...baseFilter, identityId: "does-not-exist" });
    expect(rows).toEqual([]);
  });

  it("summary() without identityId: no identity_id clause on either period", async () => {
    await summary(baseFilter);
    expect(sqlOf(0)).not.toMatch(/WHERE[\s\S]*identity_id = \$/);
    expect(sqlOf(1)).not.toMatch(/WHERE[\s\S]*identity_id = \$/);
  });

  it("summary() with identityId scopes BOTH current and previous period to it", async () => {
    await summary({ ...baseFilter, identityId: "identity-1" });

    // 4 calls (campaign + content query per period), see the promotionType test above.
    expect(queryMock).toHaveBeenCalledTimes(4);
    expect(sqlOf(0)).toMatch(/identity_id = \$\d+/);
    expect(sqlOf(1)).toMatch(/identity_id = \$\d+/);
    expect(paramsOf(0)).toContain("identity-1");
    expect(paramsOf(1)).toContain("identity-1");
  });

  it("timeseries() without identityId: no identity_id clause", async () => {
    await timeseries(baseFilter);
    expect(sqlOf()).not.toMatch(/WHERE[\s\S]*identity_id = \$/);
  });

  it("timeseries() with identityId binds it as a parameter", async () => {
    await timeseries({ ...baseFilter, identityId: "identity-1" });
    expect(sqlOf()).toMatch(/identity_id = \$\d+/);
    expect(paramsOf()).toContain("identity-1");
  });
});

describe("listCreatorOptions()", () => {
  it("reads report_campaign_daily, scoped to LIVE with a non-null identity_id", async () => {
    await listCreatorOptions(baseFilter);
    expect(sqlOf()).toContain("FROM report_campaign_daily");
    expect(sqlOf()).toContain("promotion_type = 'LIVE'");
    expect(sqlOf()).toContain("identity_id IS NOT NULL");
    expect(sqlOf()).toContain("GROUP BY identity_id");
  });

  it("never filters by promotionType param, it's hardcoded, not a caller choice", async () => {
    await listCreatorOptions(baseFilter);
    expect(paramsOf()).not.toContain("LIVE");
  });

  it("an empty result set (no LIVE identities in range) is not an error", async () => {
    queryMock.mockResolvedValueOnce([]);
    const rows = await listCreatorOptions(baseFilter);
    expect(rows).toEqual([]);
  });
});

describe("content stats (video/creator counts)", () => {
  it("summary() merges total_videos/videos_with_sales/creators_with_sales into current and previous", async () => {
    queryMock.mockReset();
    queryMock
      .mockResolvedValueOnce([{ cost: "100", orders: "5" }]) // current: campaign
      .mockResolvedValueOnce([{ cost: "10", orders: "1" }]) // previous: campaign
      .mockResolvedValueOnce([
        { total_videos: "12", videos_with_sales: "4", creators_with_sales: "3" },
      ]) // current: content
      .mockResolvedValueOnce([
        { total_videos: "8", videos_with_sales: "1", creators_with_sales: "1" },
      ]); // previous: content

    const result = (await summary(baseFilter)) as {
      current: Record<string, unknown>;
      previous: Record<string, unknown>;
    };

    expect(result.current.total_videos).toBe(12);
    expect(result.current.videos_with_sales).toBe(4);
    expect(result.current.creators_with_sales).toBe(3);
    expect(result.previous.total_videos).toBe(8);
  });

  it("dailyContentStats() reads report_creative_daily, VIDEO rows only, grouped by day", async () => {
    await dailyContentStats(baseFilter);
    expect(sqlOf()).toContain("FROM report_creative_daily");
    expect(sqlOf()).toContain("shop_content_type = 'VIDEO'");
    expect(sqlOf()).toContain("GROUP BY stat_date");
  });

  it("dailyContentStats() never filters by promotion_type, report_creative_daily has no such column", async () => {
    await dailyContentStats(baseFilter);
    expect(sqlOf()).not.toContain("promotion_type");
  });

  it("dailyAllMetrics() unions dates from both queries, defaulting the missing side to zero", async () => {
    queryMock.mockReset();
    queryMock
      .mockResolvedValueOnce([{ stat_date: "2026-08-01", cost: "50", orders: "2", gross_revenue: "100" }])
      .mockResolvedValueOnce([
        { stat_date: "2026-08-02", total_videos: "3", videos_with_sales: "1", creators_with_sales: "1" },
      ]);

    const rows = (await dailyAllMetrics(baseFilter)) as Record<string, unknown>[];

    expect(rows).toHaveLength(2);
    const aug1 = rows.find((r) => r.stat_date === "2026-08-01");
    const aug2 = rows.find((r) => r.stat_date === "2026-08-02");

    expect(aug1?.cost).toBe(50);
    expect(aug1?.total_videos).toBe(0); // no content row that day, defaulted, not missing
    expect(aug2?.cost).toBe(0); // no campaign row that day, defaulted, not missing
    expect(aug2?.total_videos).toBe(3);
  });
});
