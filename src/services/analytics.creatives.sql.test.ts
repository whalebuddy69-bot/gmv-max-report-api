import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let db: PGlite;
const queryCalls: { sql: string; params: unknown[] }[] = [];

vi.mock("../db/dataSource", () => ({
  AppDataSource: {
    query: async (sql: string, params: unknown[] = []) => {
      // analytics appends pagination parameters after the count query. Snapshot
      // parameters now, exactly as a PostgreSQL driver does when sending a query.
      const bound = structuredClone(params);
      queryCalls.push({ sql, params: bound });
      return (await db.query(sql, bound)).rows;
    },
  },
}));
vi.mock("./videoMetadata.service", () => ({ attachVideoMetadata: async (rows: unknown[]) => rows }));

import { creatives, creators, dailyContentStats, summary } from "./analytics.service";

const filter = { from: "2026-10-01", to: "2026-10-03", storeIds: ["store-a"] };
type Row = Record<string, unknown>;

async function insertCreative(overrides: Row = {}) {
  const row: Row = {
    store_id: "store-a", campaign_id: "campaign-a", item_group_id: "product-a", item_id: "100",
    stat_date: "2026-10-01", synced_at: "2026-10-02T02:00:00Z",
    title: "Video", tt_account_name: "Creator", shop_content_type: "VIDEO",
    creative_delivery_status: "Learning", cost: 10, orders: 2, gross_revenue: 100,
    product_impressions: 1000, product_clicks: 40, ...overrides,
  };
  const columns = Object.keys(row);
  await db.query(
    `INSERT INTO report_creative_daily (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(row),
  );
}

async function insertCampaign(overrides: Row = {}) {
  const row: Row = {
    store_id: "store-a", campaign_id: "campaign-a", stat_date: "2026-10-01", campaign_name: "Campaign A",
    promotion_type: "PRODUCT", cost: 10, net_cost: 9, orders: 2, gross_revenue: 100, ...overrides,
  };
  const columns = Object.keys(row);
  await db.query(
    `INSERT INTO report_campaign_daily (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(row),
  );
}

function asRows(result: { rows: unknown[] }): Row[] { return result.rows as Row[]; }
function iso(value: unknown): string { return new Date(value as string).toISOString(); }

beforeAll(async () => {
  db = new PGlite();
  // Production key constraints prevent duplicate daily observations. Query all
  // real aggregates/CTEs/lateral joins against PostgreSQL, not canned mock rows.
  await db.exec(`
    CREATE TABLE report_creative_daily (
      store_id text NOT NULL, campaign_id text NOT NULL, item_group_id text NOT NULL,
      item_id text NOT NULL, stat_date date NOT NULL, synced_at timestamptz NOT NULL,
      title text, tt_account_name text, tt_account_authorization_type text,
      tt_account_profile_image_url text, shop_content_type text, creative_delivery_status text,
      cost numeric, orders integer, gross_revenue numeric, product_impressions bigint, product_clicks bigint,
      PRIMARY KEY (store_id, campaign_id, item_group_id, item_id, stat_date)
    );
    CREATE TABLE report_campaign_daily (
      store_id text NOT NULL, campaign_id text NOT NULL, stat_date date NOT NULL,
      campaign_name text, promotion_type text, identity_id text,
      cost numeric, net_cost numeric, orders integer, gross_revenue numeric,
      PRIMARY KEY (store_id, campaign_id, stat_date)
    );
  `);
}, 30_000);

beforeEach(async () => {
  await db.exec("TRUNCATE report_creative_daily, report_campaign_daily;");
  queryCalls.length = 0;
});

afterAll(async () => { await db?.close(); });

describe("creative inventory and latest status: executed PostgreSQL queries", () => {
  it("chooses chronological status, not the lexical maximum, while retaining period totals", async () => {
    await insertCreative({ creative_delivery_status: "Learning" });
    await insertCreative({ stat_date: "2026-10-03", synced_at: "2026-10-04T02:00:00Z", creative_delivery_status: "Delivering", cost: 20, orders: 3, gross_revenue: 150 });
    const result = await creatives(filter);
    expect(result.total).toBe(1);
    const [row] = asRows(result);
    expect(row).toMatchObject({
      item_id: "100", creative_delivery_status: "Delivering", creative_delivery_status_stat_date: "2026-10-03",
      cost: 30, orders: 5, gross_revenue: 250, roi: 250 / 30, product_impressions: 2000, product_clicks: 80, product_click_rate: 4,
    });
    expect(iso(row.creative_delivery_status_checked_at)).toBe("2026-10-04T02:00:00.000Z");
  });

  it("reports a newer status outside the performance window without pulling in its spend", async () => {
    await insertCreative();
    await insertCreative({ stat_date: "2026-10-06", synced_at: "2026-10-07T01:02:03Z", creative_delivery_status: "Authorization needed", cost: 900, orders: 90, gross_revenue: 9999 });
    const [row] = asRows(await creatives(filter));
    expect(row).toMatchObject({ cost: 10, orders: 2, gross_revenue: 100, roi: 10, creative_delivery_status: "Authorization needed", creative_delivery_status_stat_date: "2026-10-06" });
    expect(iso(row.creative_delivery_status_checked_at)).toBe("2026-10-07T01:02:03.000Z");
  });

  it("does not let an old-day backfill with a later sync replace a newer report day's status", async () => {
    await insertCreative({ synced_at: "2026-10-10T00:00:00Z", creative_delivery_status: "Learning" });
    await insertCreative({ stat_date: "2026-10-06", synced_at: "2026-10-07T00:00:00Z", creative_delivery_status: "Delivering" });
    const [row] = asRows(await creatives(filter));
    expect(row.creative_delivery_status).toBe("Delivering");
    expect(row.creative_delivery_status_stat_date).toBe("2026-10-06");
    expect(iso(row.creative_delivery_status_checked_at)).toBe("2026-10-07T00:00:00.000Z");
  });

  it("reflects a same-day resync's status and checked time under the production primary key", async () => {
    await insertCreative();
    await db.query("UPDATE report_creative_daily SET creative_delivery_status = $1, synced_at = $2 WHERE item_id = $3", ["Delivering", "2026-10-07T04:00:00Z", "100"]);
    const [row] = asRows(await creatives(filter));
    expect(row).toMatchObject({ creative_delivery_status: "Delivering", creative_delivery_status_stat_date: "2026-10-01", cost: 10 });
    expect(iso(row.creative_delivery_status_checked_at)).toBe("2026-10-07T04:00:00.000Z");
  });

  it("scopes the latest status and campaign label by the exact store/campaign/product/video tuple", async () => {
    await insertCreative();
    await insertCampaign();
    await insertCampaign({ store_id: "store-b", stat_date: "2026-10-07", campaign_name: "Wrong store campaign" });
    for (const changed of [
      { store_id: "store-b" }, { campaign_id: "campaign-b" }, { item_group_id: "product-b" }, { item_id: "200" },
    ]) {
      await insertCreative({ ...changed, stat_date: "2026-10-07", creative_delivery_status: "WRONG CONTEXT" });
    }
    const result = await creatives({ ...filter, campaignId: "campaign-a", itemGroupId: "product-a" });
    expect(result.total).toBe(1);
    expect(asRows(result)[0]).toMatchObject({ creative_delivery_status: "Learning", campaign_name: "Campaign A", cost: 10 });
  });

  it("keeps an unknown newest status null, with its provenance, instead of carrying a stale status", async () => {
    await insertCreative({ creative_delivery_status: "Delivering" });
    await insertCreative({ stat_date: "2026-10-06", synced_at: "2026-10-07T03:00:00Z", creative_delivery_status: null });
    const [row] = asRows(await creatives(filter));
    expect(row.creative_delivery_status).toBeNull();
    expect(row.creative_delivery_status_stat_date).toBe("2026-10-06");
    expect(iso(row.creative_delivery_status_checked_at)).toBe("2026-10-07T03:00:00.000Z");
  });

  it("does not fabricate a period row from status-only history outside that period", async () => {
    await insertCreative({ stat_date: "2026-09-30" });
    await insertCreative({ stat_date: "2026-10-06" });
    expect(await creatives(filter)).toEqual({ rows: [], total: 0 });
    expect(await dailyContentStats(filter)).toEqual([]);
    await expect(insertCreative({ stat_date: null })).rejects.toThrow();
  });

  it("lists zero/unknown inventory and product cards without making up financial values", async () => {
    await insertCreative({ item_id: "100", cost: 0, orders: 0, gross_revenue: 0, product_impressions: 0, product_clicks: 0 });
    await insertCreative({ item_id: "200", cost: null, orders: null, gross_revenue: null, product_impressions: null, product_clicks: null });
    await insertCreative({ item_id: "-1", shop_content_type: "PRODUCT_CARD", tt_account_name: null, cost: 0, orders: 0, gross_revenue: 0, product_impressions: 0, product_clicks: 0 });
    const result = await creatives(filter);
    expect(result.total).toBe(3);
    expect(asRows(result).find((row) => row.item_id === "100")).toMatchObject({ cost: 0, orders: 0, gross_revenue: 0, roi: null, product_click_rate: null });
    expect(asRows(result).find((row) => row.item_id === "200")).toMatchObject({ cost: null, orders: null, gross_revenue: null, roi: null });
    expect(asRows(result).find((row) => row.item_id === "-1")).toMatchObject({ shop_content_type: "PRODUCT_CARD" });
    expect(asRows(result).reduce((sum, row) => sum + Number(row.cost ?? 0), 0)).toBe(0);
    expect(await dailyContentStats(filter)).toEqual([]);
    expect(await creators(filter)).toEqual([]);
    expect(await summary(filter)).toMatchObject({ current: { cost: 0, orders: 0, gross_revenue: 0, total_videos: 0, videos_with_sales: 0, creators_with_sales: 0 } });
  });

  it("does not inflate delivery KPIs, creator ranking, or totals when zero-only inventory is added", async () => {
    await insertCreative();
    await insertCampaign();
    const baseline = {
      summary: await summary(filter), daily: await dailyContentStats(filter), creators: await creators(filter),
    };
    for (const item_id of ["200", "300", "400"]) {
      await insertCreative({ item_id, tt_account_name: "Unserved creator", cost: 0, orders: 0, gross_revenue: 0, product_impressions: 0, product_clicks: 0 });
    }
    // An additional zero-only day for the active video must not add delivery.
    await insertCreative({ stat_date: "2026-10-02", cost: 0, orders: 0, gross_revenue: 0, product_impressions: 0, product_clicks: 0 });
    expect(await summary(filter)).toEqual(baseline.summary);
    expect(await dailyContentStats(filter)).toEqual(baseline.daily);
    expect(await creators(filter)).toEqual(baseline.creators);
    const result = await creatives(filter);
    expect(result.total).toBe(4);
    expect(asRows(result).find((row) => row.item_id === "100")).toMatchObject({ cost: 10, orders: 2, gross_revenue: 100 });
  });

  it("retains the historical cost OR orders OR impressions delivery predicate", async () => {
    for (const [index, activity] of [ { cost: 1 }, { orders: 1 }, { product_impressions: 1 } ].entries()) {
      await insertCreative({ item_id: String(index + 1), tt_account_name: `Creator ${index}`, cost: 0, orders: 0, gross_revenue: 0, product_impressions: 0, product_clicks: 0, ...activity });
    }
    await insertCreative({ item_id: "200", tt_account_name: "Revenue-only", cost: 0, orders: 0, gross_revenue: 99, product_impressions: 0 });
    await insertCreative({ item_id: "300", tt_account_name: "Unknown", cost: null, orders: null, gross_revenue: null, product_impressions: null });
    await insertCreative({ item_id: "-1", shop_content_type: "PRODUCT_CARD", tt_account_name: null });
    expect(await dailyContentStats(filter)).toEqual([{ stat_date: "2026-10-01", total_videos: 3, videos_with_sales: 1, creators_with_sales: 1 }]);
    expect(await summary(filter)).toMatchObject({ current: { total_videos: 3, videos_with_sales: 1, creators_with_sales: 1 } });
    expect(await creators(filter)).toHaveLength(3);
    expect((await creatives(filter)).total).toBe(6);
  });

  it("uses stable complete identity tie-breakers across zero-cost pagination", async () => {
    for (const item_id of ["700", "100", "500", "300", "200"]) {
      await insertCreative({ item_id, cost: 0, orders: 0, gross_revenue: 0, product_impressions: 0 });
    }
    await insertCreative({ item_id: "100", item_group_id: "product-b", cost: 0 });
    await insertCreative({ item_id: "100", campaign_id: "campaign-b", cost: 0 });
    await insertCreative({ item_id: "999", cost: null });
    const all = asRows(await creatives(filter, "cost", "DESC", 100, 0));
    const paged: Row[] = [];
    for (const offset of [0, 3, 6]) {
      const page = await creatives(filter, "cost", "DESC", 3, offset);
      expect(page.total).toBe(8);
      paged.push(...asRows(page));
    }
    expect(paged).toEqual(all);
    expect(paged.map((row) => [row.campaign_id, row.item_group_id, row.item_id].join("/"))).toEqual([
      "campaign-a/product-a/100", "campaign-a/product-a/200", "campaign-a/product-a/300", "campaign-a/product-a/500", "campaign-a/product-a/700",
      "campaign-a/product-b/100", "campaign-b/product-a/100", "campaign-a/product-a/999",
    ]);
    expect((await creatives(filter, "cost", "DESC", 3, 9)).rows).toEqual([]);
  });

  it("binds store/campaign/product/creator/content filters and rejects injected sort text", async () => {
    const quoted = "value' OR 1=1; --";
    await insertCreative({ store_id: quoted, campaign_id: quoted, item_group_id: quoted, tt_account_name: quoted });
    await insertCreative({ item_id: "200" });
    const result = await creatives({ ...filter, storeIds: [quoted, "not-selected"], campaignId: quoted, itemGroupId: quoted, accountName: quoted, contentType: "VIDEO" }, "cost; DROP TABLE report_creative_daily; --");
    expect(result.total).toBe(1);
    expect(asRows(result)[0]).toMatchObject({ store_id: quoted, campaign_id: quoted, item_group_id: quoted, tt_account_name: quoted });
    expect(queryCalls.every(({ sql }) => !sql.includes(quoted) && !sql.includes("DROP TABLE"))).toBe(true);
    expect(queryCalls[0].params).toEqual([filter.from, filter.to, [quoted, "not-selected"], quoted, quoted, quoted, "VIDEO"]);
    expect(queryCalls[1].params).toEqual([...queryCalls[0].params, 100, 0]);
    expect((await db.query("SELECT count(*) AS count FROM report_creative_daily")).rows).toEqual([{ count: 2 }]);
  });
});
