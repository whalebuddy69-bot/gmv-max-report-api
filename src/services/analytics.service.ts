import { AppDataSource } from "../db/dataSource";
import { attachVideoMetadata } from "./videoMetadata.service";

/**
 * Aggregation queries for the web dashboard.
 *
 * All user input is passed as bound parameters; sort columns are checked against an
 * allowlist. Only report_campaign_daily has promotion_type, so only the campaign-level
 * queries pass { promotionType: true } to scope().
 */

export interface RangeFilter {
  /** Empty means all stores. */
  storeIds?: string[];
  from: string;
  to: string;
  campaignId?: string;
  itemGroupId?: string;
  /** PRODUCT | LIVE | ALL. Used only with scope(..., { promotionType: true }). */
  promotionType?: "PRODUCT" | "LIVE" | "ALL";
  /** LIVE identity_id. Used with scope(..., { identity: true }) and by liveRooms(). */
  identityId?: string;
}

/** Shared WHERE builder. Returns the fragment plus positional params. */
function scope(
  filter: RangeFilter,
  extra: { campaign?: boolean; product?: boolean; promotionType?: boolean; identity?: boolean } = {}
) {
  const where: string[] = ["stat_date BETWEEN $1 AND $2"];
  const params: unknown[] = [filter.from, filter.to];

  const storeIds = filter.storeIds ?? [];
  if (storeIds.length === 1) {
    params.push(storeIds[0]);
    where.push(`store_id = $${params.length}`);
  } else if (storeIds.length > 1) {
    params.push(storeIds);
    where.push(`store_id = ANY($${params.length})`);
  }
  if (extra.campaign && filter.campaignId) {
    params.push(filter.campaignId);
    where.push(`campaign_id = $${params.length}`);
  }
  if (extra.product && filter.itemGroupId) {
    params.push(filter.itemGroupId);
    where.push(`item_group_id = $${params.length}`);
  }
  if (extra.identity && filter.identityId) {
    params.push(filter.identityId);
    where.push(`identity_id = $${params.length}`);
  }
  if (extra.promotionType) {
    const type = filter.promotionType ?? "PRODUCT";
    if (type !== "ALL") {
      params.push(type);
      where.push(`promotion_type = $${params.length}`);
    }
  }

  return { clause: where.join(" AND "), params };
}

/** Converts numeric string columns from pg into numbers. */
function toNumbers<T extends Record<string, unknown>>(rows: T[], keys: string[]): T[] {
  const wanted = new Set(keys);
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const key of Object.keys(out)) {
      if (!wanted.has(key)) continue;
      const v = out[key];
      out[key] = v === null || v === undefined ? null : Number(v);
    }
    return out as T;
  });
}

const MONEY_KEYS = [
  "cost",
  "net_cost",
  "orders",
  "gross_revenue",
  "roi",
  "cost_per_order",
  "product_impressions",
  "product_clicks",
  "product_click_rate",
  "ad_click_rate",
  "ad_conversion_rate",
  "creatives",
  "creators",
  "campaigns",
  "products",
];

// Inventory can include unserved videos. Preserve the pre-inventory definition of
// activity for delivery KPIs and creator rankings, not for the creative detail table.
const CREATIVE_ACTIVITY = "(coalesce(cost,0) > 0 OR coalesce(orders,0) > 0 OR coalesce(product_impressions,0) > 0)";

// --- dropdowns ---

export async function listStoresWithData(): Promise<unknown[]> {
  return AppDataSource.query(`
    SELECT t.store_id, t.store_name, t.advertiser_id, t.enabled, t.last_synced_at,
           d.first_date, d.last_date
    FROM sync_targets t
    LEFT JOIN (
      -- to_char for the same reason as in timeseries(): a bare date column would come
      -- back shifted a day once serialised to JSON.
      -- Unfiltered by promotion_type on purpose: a store that only ever runs Live
      -- campaigns should still report its own data range here, not read as having none.
      SELECT store_id,
             to_char(min(stat_date), 'YYYY-MM-DD') AS first_date,
             to_char(max(stat_date), 'YYYY-MM-DD') AS last_date
      FROM report_campaign_daily GROUP BY store_id
    ) d ON d.store_id = t.store_id
    ORDER BY t.store_name NULLS LAST, t.store_id
  `);
}

export async function listCampaignOptions(filter: RangeFilter): Promise<unknown[]> {
  const { clause, params } = scope(filter, { promotionType: true });
  return AppDataSource.query(
    `SELECT campaign_id, max(campaign_name) AS campaign_name, sum(cost) AS cost
     FROM report_campaign_daily WHERE ${clause}
     GROUP BY campaign_id ORDER BY sum(cost) DESC NULLS LAST`,
    params
  );
}

// --- KPI summary ---

export async function summary(filter: RangeFilter): Promise<unknown> {
  const totals = async (from: string, to: string) => {
    const { clause, params } = scope({ ...filter, from, to }, { promotionType: true, identity: true });
    const [row] = await AppDataSource.query(
      `SELECT coalesce(sum(cost),0) AS cost,
              coalesce(sum(net_cost),0) AS net_cost,
              coalesce(sum(orders),0) AS orders,
              coalesce(sum(gross_revenue),0) AS gross_revenue,
              CASE WHEN sum(cost) > 0 THEN sum(gross_revenue)/sum(cost) END AS roi,
              CASE WHEN sum(orders) > 0 THEN sum(cost)/sum(orders) END AS cost_per_order,
              count(DISTINCT campaign_id) AS campaigns
       FROM report_campaign_daily WHERE ${clause}`,
      params
    );

    const contentRow = await contentStatsFor({ ...filter, from, to });

    return toNumbers(
      [{ ...row, ...contentRow }],
      [...MONEY_KEYS, "total_videos", "videos_with_sales", "creators_with_sales"]
    )[0];
  };

  // Same-length window immediately before the requested one.
  const days = daysBetween(filter.from, filter.to);
  const prevTo = shift(filter.from, -1);
  const prevFrom = shift(prevTo, -(days - 1));

  const [current, previous] = await Promise.all([
    totals(filter.from, filter.to),
    totals(prevFrom, prevTo),
  ]);

  return {
    range: { from: filter.from, to: filter.to, days },
    previousRange: { from: prevFrom, to: prevTo },
    current,
    previous,
  };
}

/**
 * Video and creator counts for the KPI cards. Counts only videos with delivery in the
 * range; product cards are excluded.
 */
async function contentStatsFor(filter: RangeFilter): Promise<Record<string, unknown>> {
  const { clause, params } = scope(filter);
  const [row] = await AppDataSource.query(
    `WITH per_item AS (
       SELECT item_id, tt_account_name, sum(orders) AS orders
       FROM report_creative_daily
       WHERE ${clause} AND shop_content_type = 'VIDEO' AND ${CREATIVE_ACTIVITY}
       GROUP BY item_id, tt_account_name
     )
     SELECT coalesce(count(*), 0) AS total_videos,
            coalesce(count(*) FILTER (WHERE orders > 0), 0) AS videos_with_sales,
            coalesce(count(DISTINCT tt_account_name) FILTER (WHERE orders > 0), 0) AS creators_with_sales
     FROM per_item`,
    params
  );
  return row ?? { total_videos: 0, videos_with_sales: 0, creators_with_sales: 0 };
}

/** Same as contentStatsFor(), per day. */
export async function dailyContentStats(filter: RangeFilter): Promise<unknown[]> {
  const { clause, params } = scope(filter);
  const rows = await AppDataSource.query(
    `WITH per_item_day AS (
       SELECT stat_date, item_id, tt_account_name, sum(orders) AS orders
       FROM report_creative_daily
       WHERE ${clause} AND shop_content_type = 'VIDEO' AND ${CREATIVE_ACTIVITY}
       GROUP BY stat_date, item_id, tt_account_name
     )
     SELECT to_char(stat_date, 'YYYY-MM-DD') AS stat_date,
            coalesce(count(*), 0) AS total_videos,
            coalesce(count(*) FILTER (WHERE orders > 0), 0) AS videos_with_sales,
            coalesce(count(DISTINCT tt_account_name) FILTER (WHERE orders > 0), 0) AS creators_with_sales
     FROM per_item_day
     GROUP BY stat_date
     ORDER BY stat_date`,
    params
  );
  return toNumbers(rows, ["total_videos", "videos_with_sales", "creators_with_sales"]);
}

/** Daily campaign metrics (PRODUCT) combined with the daily content counts. */
export async function dailyAllMetrics(filter: RangeFilter): Promise<unknown[]> {
  const { clause, params } = scope(filter, { promotionType: true, identity: true });
  const moneyRows: Record<string, unknown>[] = await AppDataSource.query(
    `SELECT to_char(stat_date, 'YYYY-MM-DD') AS stat_date,
            sum(cost) AS cost, sum(orders) AS orders, sum(gross_revenue) AS gross_revenue,
            CASE WHEN sum(cost) > 0 THEN sum(gross_revenue)/sum(cost) END AS roi
     FROM report_campaign_daily WHERE ${clause}
     GROUP BY stat_date ORDER BY stat_date`,
    params
  );
  const contentRows = (await dailyContentStats(filter)) as Record<string, unknown>[];

  // include dates that only appear on one side
  const moneyByDate = new Map(moneyRows.map((r) => [r.stat_date as string, r]));
  const contentByDate = new Map(contentRows.map((r) => [r.stat_date as string, r]));
  const dates = [...new Set([...moneyByDate.keys(), ...contentByDate.keys()])].sort();

  const merged = dates.map((stat_date) => ({
    stat_date,
    cost: 0,
    orders: 0,
    gross_revenue: 0,
    roi: null,
    total_videos: 0,
    videos_with_sales: 0,
    creators_with_sales: 0,
    ...moneyByDate.get(stat_date),
    ...contentByDate.get(stat_date),
  }));

  return toNumbers(merged, [...MONEY_KEYS, "total_videos", "videos_with_sales", "creators_with_sales"]);
}

// --- time series ---

export async function timeseries(filter: RangeFilter): Promise<unknown[]> {
  const { clause, params } = scope(filter, { campaign: true, promotionType: true, identity: true });
  const rows = await AppDataSource.query(
    // to_char avoids pg converting the date to a JS Date (timezone shift)
    `SELECT to_char(stat_date, 'YYYY-MM-DD') AS stat_date,
            sum(cost) AS cost, sum(orders) AS orders, sum(gross_revenue) AS gross_revenue,
            CASE WHEN sum(cost) > 0 THEN sum(gross_revenue)/sum(cost) END AS roi
     FROM report_campaign_daily WHERE ${clause}
     GROUP BY stat_date ORDER BY stat_date`,
    params
  );
  return toNumbers(rows, MONEY_KEYS);
}

// --- tables ---

const CAMPAIGN_SORTS = new Set(["cost", "orders", "gross_revenue", "roi", "campaign_name"]);

export async function campaigns(
  filter: RangeFilter,
  sort = "cost",
  direction: "ASC" | "DESC" = "DESC"
): Promise<unknown[]> {
  const { clause, params } = scope(filter, { campaign: true, promotionType: true, identity: true });
  const orderBy = CAMPAIGN_SORTS.has(sort) ? sort : "cost";
  const dir = direction === "ASC" ? "ASC" : "DESC";

  const rows = await AppDataSource.query(
    `SELECT store_id,
            campaign_id,
            max(campaign_name) AS campaign_name,
            max(operation_status) AS operation_status,
            max(roas_bid) AS roas_bid,
            -- max() rather than a bare column, matching campaign_name/operation_status
            -- above: this is grouped by campaign, and each of these is constant across
            -- every daily row a campaign has, so max() just picks that one value.
            max(promotion_type) AS promotion_type,
            max(identity_id) AS identity_id,
            max(tt_account_name) AS tt_account_name,
            max(tt_account_profile_image_url) AS tt_account_profile_image_url,
            sum(cost) AS cost, sum(net_cost) AS net_cost, sum(orders) AS orders,
            sum(gross_revenue) AS gross_revenue,
            CASE WHEN sum(cost) > 0 THEN sum(gross_revenue)/sum(cost) END AS roi,
            CASE WHEN sum(orders) > 0 THEN sum(cost)/sum(orders) END AS cost_per_order
     FROM report_campaign_daily WHERE ${clause}
     GROUP BY store_id, campaign_id
     ORDER BY ${orderBy} ${dir} NULLS LAST`,
    params
  );
  return toNumbers(rows, [...MONEY_KEYS, "roas_bid"]);
}

export async function products(filter: RangeFilter): Promise<unknown[]> {
  const { clause, params } = scope(filter, { campaign: true, product: true });
  const rows = await AppDataSource.query(
    `SELECT store_id,
            item_group_id,
            max(product_name) AS product_name,
            max(product_status) AS product_status,
            max(product_image_url) AS product_image_url,
            count(DISTINCT campaign_id) AS campaigns,
            sum(cost) AS cost, sum(orders) AS orders, sum(gross_revenue) AS gross_revenue,
            CASE WHEN sum(cost) > 0 THEN sum(gross_revenue)/sum(cost) END AS roi,
            CASE WHEN sum(orders) > 0 THEN sum(cost)/sum(orders) END AS cost_per_order
     FROM report_product_daily WHERE ${clause}
     GROUP BY store_id, item_group_id ORDER BY sum(cost) DESC NULLS LAST`,
    params
  );
  return toNumbers(rows, MONEY_KEYS);
}

/** Creator ranking. Product cards are excluded. */
export async function creators(filter: RangeFilter, minCost = 0): Promise<unknown[]> {
  const { clause, params } = scope(filter, { campaign: true, product: true });
  params.push(minCost);

  const rows = await AppDataSource.query(
    `SELECT tt_account_name,
            max(tt_account_authorization_type) AS authorization_type,
            max(tt_account_profile_image_url) AS tt_account_profile_image_url,
            count(DISTINCT item_id) AS creatives,
            count(DISTINCT campaign_id) AS campaigns,
            sum(cost) AS cost, sum(orders) AS orders, sum(gross_revenue) AS gross_revenue,
            CASE WHEN sum(cost) > 0 THEN sum(gross_revenue)/sum(cost) END AS roi,
            CASE WHEN sum(orders) > 0 THEN sum(cost)/sum(orders) END AS cost_per_order,
            sum(product_impressions) AS product_impressions,
            sum(product_clicks) AS product_clicks,
            CASE WHEN sum(product_impressions) > 0
                 THEN 100.0 * sum(product_clicks)/sum(product_impressions) END AS product_click_rate
     FROM report_creative_daily
     WHERE ${clause} AND tt_account_name IS NOT NULL AND ${CREATIVE_ACTIVITY}
     GROUP BY tt_account_name
     HAVING coalesce(sum(cost),0) >= $${params.length}
     ORDER BY sum(cost) DESC NULLS LAST`,
    params
  );
  return toNumbers(rows, MONEY_KEYS);
}

const CREATIVE_SORTS = new Set([
  "cost",
  "orders",
  "gross_revenue",
  "roi",
  "product_impressions",
  "product_clicks",
]);

export async function creatives(
  filter: RangeFilter & { accountName?: string; contentType?: string },
  sort = "cost",
  direction: "ASC" | "DESC" = "DESC",
  limit = 100,
  offset = 0
): Promise<{ rows: unknown[]; total: number }> {
  const { clause, params } = scope(filter, { campaign: true, product: true });
  const extra: string[] = [];

  if (filter.accountName) {
    params.push(filter.accountName);
    extra.push(`tt_account_name = $${params.length}`);
  }
  if (filter.contentType) {
    params.push(filter.contentType);
    extra.push(`shop_content_type = $${params.length}`);
  }

  const where = [clause, ...extra].join(" AND ");
  const orderBy = CREATIVE_SORTS.has(sort) ? sort : "cost";
  const dir = direction === "ASC" ? "ASC" : "DESC";

  const [countRow] = await AppDataSource.query(
    `SELECT count(*) AS total FROM (
       SELECT 1 FROM report_creative_daily WHERE ${where}
       GROUP BY store_id, campaign_id, item_group_id, item_id
     ) x`,
    params
  );

  params.push(limit, offset);
  const rows = await AppDataSource.query(
    `WITH performance AS (
       SELECT store_id,
            campaign_id, item_group_id, item_id,
            max(title) AS title,
            max(tt_account_name) AS tt_account_name,
            max(tt_account_authorization_type) AS authorization_type,
            max(tt_account_profile_image_url) AS tt_account_profile_image_url,
            max(shop_content_type) AS shop_content_type,
            sum(cost) AS cost, sum(orders) AS orders, sum(gross_revenue) AS gross_revenue,
            CASE WHEN sum(cost) > 0 THEN sum(gross_revenue)/sum(cost) END AS roi,
            sum(product_impressions) AS product_impressions,
            sum(product_clicks) AS product_clicks,
            CASE WHEN sum(product_impressions) > 0
                 THEN 100.0 * sum(product_clicks)/sum(product_impressions) END AS product_click_rate
       FROM report_creative_daily
       WHERE ${where}
       GROUP BY store_id, campaign_id, item_group_id, item_id
       ORDER BY ${orderBy} ${dir} NULLS LAST, store_id, campaign_id, item_group_id, item_id
       LIMIT $${params.length - 1} OFFSET $${params.length}
     )
     SELECT c.*, campaign_name_ref.campaign_name,
            latest.creative_delivery_status,
            latest.synced_at AS creative_delivery_status_checked_at,
            to_char(latest.stat_date, 'YYYY-MM-DD') AS creative_delivery_status_stat_date
     FROM performance c
     LEFT JOIN LATERAL (
       SELECT campaign_name FROM report_campaign_daily
       WHERE campaign_id = c.campaign_id AND store_id = c.store_id
       ORDER BY stat_date DESC
       LIMIT 1
     ) campaign_name_ref ON true
     LEFT JOIN LATERAL (
       -- Status is latest KNOWN for this exact context, independently of the
       -- performance window. A fresh backfill of an old day must not supersede
       -- the newest report day. Keep a newest null status unknown, not stale.
       SELECT creative_delivery_status, stat_date, synced_at
       FROM report_creative_daily s
       WHERE s.store_id = c.store_id AND s.campaign_id = c.campaign_id
         AND s.item_group_id = c.item_group_id AND s.item_id = c.item_id
       ORDER BY s.stat_date DESC, s.synced_at DESC
       LIMIT 1
     ) latest ON true
     ORDER BY c.${orderBy} ${dir} NULLS LAST, c.store_id, c.campaign_id, c.item_group_id, c.item_id`,
    params
  );

  return { rows: await attachVideoMetadata(toNumbers(rows, MONEY_KEYS)), total: Number(countRow?.total ?? 0) };
}

const LIVE_ROOM_MONEY_KEYS = [
  ...MONEY_KEYS,
  "live_views",
  "live_views_10s",
  "live_follows",
  "cost_per_live_view",
  "cost_per_live_view_10s",
];

/**
 * LIVE room table. Ratios are recomputed from the summed values. identityId is
 * filtered through report_campaign_daily since this table has no identity_id.
 */
export async function liveRooms(filter: RangeFilter): Promise<unknown[]> {
  const { clause, params } = scope(filter, { campaign: true });

  let identityClause = "";
  if (filter.identityId) {
    params.push(filter.identityId);
    identityClause = `
       AND campaign_id IN (
         SELECT campaign_id FROM report_campaign_daily
         WHERE identity_id = $${params.length} AND stat_date BETWEEN $1 AND $2
       )`;
  }

  const rows = await AppDataSource.query(
    `SELECT store_id,
            campaign_id,
            room_id,
            max(live_name) AS live_name,
            max(live_status) AS live_status,
            max(live_launched_time) AS live_launched_time,
            max(live_duration) AS live_duration,
            sum(cost) AS cost, sum(net_cost) AS net_cost, sum(orders) AS orders,
            sum(gross_revenue) AS gross_revenue,
            CASE WHEN sum(cost) > 0 THEN sum(gross_revenue)/sum(cost) END AS roi,
            CASE WHEN sum(orders) > 0 THEN sum(cost)/sum(orders) END AS cost_per_order,
            sum(live_views) AS live_views,
            sum(live_views_10s) AS live_views_10s,
            CASE WHEN sum(live_views) > 0 THEN sum(cost)/sum(live_views) END AS cost_per_live_view,
            CASE WHEN sum(live_views_10s) > 0
                 THEN sum(cost)/sum(live_views_10s) END AS cost_per_live_view_10s,
            sum(live_follows) AS live_follows
     FROM report_live_room_daily WHERE ${clause}${identityClause}
     GROUP BY store_id, campaign_id, room_id
     ORDER BY sum(cost) DESC NULLS LAST`,
    params
  );
  return toNumbers(withDerivedTiming(rows), [...LIVE_ROOM_MONEY_KEYS, "duration_seconds"]);
}

/** LIVE identities for the creator dropdown. */
export async function listCreatorOptions(filter: RangeFilter): Promise<unknown[]> {
  const { clause, params } = scope(filter);
  const rows = await AppDataSource.query(
    `SELECT identity_id, max(tt_account_name) AS tt_account_name, sum(cost) AS cost
     FROM report_campaign_daily
     WHERE ${clause} AND promotion_type = 'LIVE' AND identity_id IS NOT NULL
     GROUP BY identity_id
     ORDER BY sum(cost) DESC NULLS LAST`,
    params
  );
  return toNumbers(rows, ["cost"]);
}

/**
 * Derives start_date, start_time, end_time and duration_seconds from live_launched_time
 * ("2026-09-03 01:01:44") and live_duration ("15h 59m"). Unparseable values give nulls.
 */
function withDerivedTiming(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const launched = splitLaunchedTime(row.live_launched_time);
    const durationSeconds = parseDurationSeconds(row.live_duration);
    const endTime =
      launched && durationSeconds !== null
        ? addSeconds(row.live_launched_time as string, durationSeconds)
        : null;

    return {
      ...row,
      start_date: launched?.date ?? null,
      start_time: launched?.time ?? null,
      end_time: endTime,
      duration_seconds: durationSeconds,
    };
  });
}

const LAUNCHED_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;

function splitLaunchedTime(value: unknown): { date: string; time: string } | null {
  if (typeof value !== "string") return null;
  const match = LAUNCHED_TIME_PATTERN.exec(value);
  return match ? { date: match[1], time: match[2] } : null;
}

/** Parses "1d 2h 3m 4s" (any subset). Returns null if nothing matches. */
const DURATION_PATTERN = /(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i;

function parseDurationSeconds(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const match = DURATION_PATTERN.exec(value);
  if (!match) return null;
  const [, d, h, m, s] = match;
  if (!d && !h && !m && !s) return null;
  return Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(m ?? 0) * 60 + Number(s ?? 0);
}

/** Adds seconds to a "YYYY-MM-DD HH:MM:SS" string (no timezone conversion). */
function addSeconds(timestamp: string, seconds: number): string {
  const ms = Date.parse(`${timestamp.replace(" ", "T")}Z`) + seconds * 1000;
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

// --- helpers ---

function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.max(1, Math.floor(ms / 86_400_000) + 1);
}

function shift(isoDate: string, delta: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
