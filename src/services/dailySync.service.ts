import { randomUUID } from "crypto";
import { AppDataSource } from "../db/dataSource";
import { CampaignDaily } from "../entities/CampaignDaily";
import { CreativeDaily } from "../entities/CreativeDaily";
import { LiveRoomDaily } from "../entities/LiveRoomDaily";
import { ProductDaily } from "../entities/ProductDaily";
import { SyncRun, SyncRowCounts } from "../entities/SyncRun";
import { StoreCatalog } from "../entities/StoreCatalog";
import { SyncTarget } from "../entities/SyncTarget";
import { config } from "../config";
import { describeError } from "../utils/errors";
import { logger } from "../utils/logger";
import { MetricValue, ReportRow, StoreContext, TikTokApiService } from "./tiktokApi.service";
import { getAccessTokenForAdvertiser } from "./token.service";
import { listStoresForAdvertiser, StoreSummary } from "./store.service";
import { provisionCreatorForStore, ProvisionOutcome } from "./creatorProvisioning.service";
import { startVideoMetadataRefresh } from "./videoMetadata.service";

/**
 * Syncs GMV Max reports into the daily tables used by the analytics endpoints.
 *
 * Data is pulled per day and upserted, and each run re-pulls the last
 * SYNC_LOOKBACK_DAYS days because TikTok updates recent numbers late.
 * Product and creative rows exist for PRODUCT campaigns only; LIVE campaigns get
 * campaign and live room rows.
 */

const CAMPAIGN_METRICS = [
  "campaign_id",
  "campaign_name",
  "operation_status",
  "bid_type",
  "roas_bid",
  "target_roi_budget",
  "max_delivery_budget",
  "cost",
  "net_cost",
  "orders",
  "cost_per_order",
  "gross_revenue",
  "roi",
] as const;

/** CAMPAIGN_METRICS plus LIVE-only fields. */
const LIVE_CAMPAIGN_METRICS = [
  ...CAMPAIGN_METRICS,
  "tt_account_name",
  "tt_account_profile_image_url",
  "identity_id",
  "live_views",
  "cost_per_live_view",
  "10_second_live_views",
  "cost_per_10_second_live_view",
  "live_follows",
] as const;

const LIVE_ROOM_METRICS = [
  "live_name",
  "live_status",
  "live_launched_time",
  "live_duration",
  "cost",
  "net_cost",
  "orders",
  "cost_per_order",
  "gross_revenue",
  "roi",
  "live_views",
  "cost_per_live_view",
  "10_second_live_views",
  "cost_per_10_second_live_view",
  "live_follows",
] as const;

const PRODUCT_METRICS = [
  "item_group_id",
  "product_name",
  "product_status",
  "product_image_url",
  "cost",
  "orders",
  "cost_per_order",
  "gross_revenue",
  "roi",
] as const;

const CREATIVE_METRICS = [
  "item_id",
  "title",
  "tt_account_name",
  "tt_account_authorization_type",
  "tt_account_profile_image_url",
  "shop_content_type",
  "creative_delivery_status",
  "cost",
  "orders",
  "cost_per_order",
  "gross_revenue",
  "roi",
  "product_impressions",
  "product_clicks",
  "product_click_rate",
  "ad_click_rate",
  "ad_conversion_rate",
  "ad_video_view_rate_2s",
  "ad_video_view_rate_6s",
  "ad_video_view_rate_p25",
  "ad_video_view_rate_p50",
  "ad_video_view_rate_p75",
  "ad_video_view_rate_p100",
] as const;

const UPSERT_BATCH = 500;

export interface SyncResult {
  runId: string;
  advertiserId: string;
  storeId: string;
  startDate: string;
  endDate: string;
  rowCounts: SyncRowCounts;
  apiCalls: number;
}

// --- target discovery ---

/**
 * Adds a sync target for each store whose exclusive GMV Max advertiser has a token.
 * Also updates the bot's creators table; `provisioned` is the number of rows changed.
 */
export interface DiscoverResult {
  targets: SyncTarget[];
  provisioned: { created: number; backfilled: number };
}

/** Upserts one advertiser's store list into store_catalog. */
async function upsertCatalog(advertiserId: string, stores: StoreSummary[]): Promise<void> {
  if (stores.length === 0) return;

  // TikTok sometimes returns the same store twice, and ON CONFLICT fails on duplicates
  // within one statement.
  const byKey = new Map<string, StoreSummary>();
  for (const store of stores) {
    byKey.set(`${advertiserId}:${store.storeId}`, store);
  }

  const rows = [...byKey.values()].map((store) => ({
    advertiserId,
    storeId: store.storeId,
    storeName: store.storeName,
    storeCode: store.storeCode ?? null,
    isGmvMaxAvailable: store.isGmvMaxAvailable,
    storeStatus: store.storeStatus ?? null,
    exclusiveAdvertiserId: store.exclusiveAdvertiserId ?? null,
    exclusiveAdvertiserName: store.exclusiveAdvertiserName ?? null,
    storeAuthorizedBcId: store.storeAuthorizedBcId ?? null,
    bcName: store.bcName ?? null,
    seenAt: new Date(),
  }));

  await AppDataSource.createQueryBuilder()
    .insert()
    .into(StoreCatalog)
    .values(rows)
    .orUpdate(
      [
        "store_name",
        "store_code",
        "is_gmv_max_available",
        "store_status",
        "exclusive_advertiser_id",
        "exclusive_advertiser_name",
        "store_authorized_bc_id",
        "bc_name",
        "seen_at",
      ],
      ["advertiser_id", "store_id"],
    )
    .execute();
}

export async function discoverSyncTargets(): Promise<DiscoverResult> {
  const targets = AppDataSource.getRepository(SyncTarget);
  const provisioned = { created: 0, backfilled: 0 };
  const tally = (outcome: ProvisionOutcome) => {
    if (outcome === "created") provisioned.created += 1;
    if (outcome === "backfilled") provisioned.backfilled += 1;
  };

  const advertiserIds: string[] = (
    await AppDataSource.query(
      `SELECT DISTINCT advertiser_id FROM oauth_tokens WHERE revoked_at IS NULL`
    )
  ).map((r: { advertiser_id: string }) => r.advertiser_id);

  for (const advertiserId of advertiserIds) {
    let stores;
    try {
      stores = await listStoresForAdvertiser(advertiserId);
    } catch (err) {
      logger.warn("Store discovery failed", { advertiserId, error: describeError(err) });
      continue;
    }

    await upsertCatalog(advertiserId, stores);

    for (const store of stores) {
      if (store.exclusiveAdvertiserId !== advertiserId) continue;

      if (store.storeAuthorizedBcId) {
        tally(
          await provisionCreatorForStore({
            advertiserId,
            storeId: store.storeId,
            storeName: store.storeName,
            storeAuthorizedBcId: store.storeAuthorizedBcId,
          })
        );
      }

      const existing = await targets.findOne({
        where: { advertiserId, storeId: store.storeId },
      });
      if (existing) {
        // Refresh the label only; never touch `enabled`.
        if (existing.storeName !== store.storeName) {
          existing.storeName = store.storeName;
          await targets.save(existing);
        }
        continue;
      }

      await targets.save(
        targets.create({ advertiserId, storeId: store.storeId, storeName: store.storeName, enabled: true })
      );
      logger.info("Discovered sync target", { advertiserId, storeId: store.storeId, storeName: store.storeName });
    }
  }

  return { targets: await targets.find({ order: { id: "ASC" } }), provisioned };
}

// --- sync ---

export async function syncAllTargets(): Promise<SyncResult[]> {
  const targets = await AppDataSource.getRepository(SyncTarget).find({
    where: { enabled: true },
    order: { id: "ASC" },
  });

  if (targets.length === 0) {
    logger.warn("No enabled sync targets, nothing to sync");
    return [];
  }

  const results: SyncResult[] = [];
  for (const target of targets) {
    try {
      results.push(await syncTarget(target));
    } catch (err) {
      logger.error("Sync failed", {
        advertiserId: target.advertiserId,
        storeId: target.storeId,
        error: describeError(err),
      });
    }
  }
  return results;
}

export async function syncTarget(target: SyncTarget, lookbackDays?: number): Promise<SyncResult> {
  const days = lookbackDays ?? config.sync.lookbackDays;
  const endDate = todayInAccountTz();
  const startDate = shiftDays(endDate, -(days - 1));

  const runs = AppDataSource.getRepository(SyncRun);
  const run = runs.create({
    id: randomUUID(),
    advertiserId: target.advertiserId,
    storeId: target.storeId,
    startDate,
    endDate,
    status: "running",
    apiCalls: 0,
  });
  await runs.save(run);

  // Hoisted out of the try so the catch can report the spend that led to the failure.
  let apiCallsSoFar = 0;

  try {
    const accessToken = await getAccessTokenForAdvertiser(target.advertiserId);
    const api = new TikTokApiService(accessToken, target.advertiserId);

    const stores = await api.listStores();
    apiCallsSoFar = 1;
    const store = stores.find((s) => s.store_id === target.storeId);
    if (!store?.store_authorized_bc_id) {
      throw new Error(`ไม่พบ store ${target.storeId} หรือไม่มี store_authorized_bc_id`);
    }

    const ctx: StoreContext = {
      advertiserId: target.advertiserId,
      storeId: target.storeId,
      storeAuthorizedBcId: store.store_authorized_bc_id,
    };

    const counts = await syncWindow(api, ctx, startDate, endDate, (n) => {
      apiCallsSoFar += n;
    });

    run.status = "success";
    run.apiCalls = apiCallsSoFar;
    run.rowCounts = counts;
    run.finishedAt = new Date();
    await runs.save(run);

    target.lastSyncedAt = new Date();
    target.lastError = null;
    await AppDataSource.getRepository(SyncTarget).save(target);

    logger.info("Sync finished", {
      storeId: target.storeId,
      range: `${startDate}..${endDate}`,
      ...counts,
      apiCalls: apiCallsSoFar,
    });

    // Independent, bounded background enrichment. A public-page failure must never
    // turn a successfully saved TikTok performance report into a failed sync.
    startVideoMetadataRefresh(target.storeId);

    return {
      runId: run.id,
      advertiserId: target.advertiserId,
      storeId: target.storeId,
      startDate,
      endDate,
      rowCounts: counts,
      apiCalls: apiCallsSoFar,
    };
  } catch (err) {
    run.status = "failed";
    run.errorMessage = describeError(err);
    run.apiCalls = apiCallsSoFar;
    run.finishedAt = new Date();
    await runs.save(run).catch(() => undefined);

    target.lastError = describeError(err);
    await AppDataSource.getRepository(SyncTarget).save(target).catch(() => undefined);
    throw err;
  }
}

async function syncWindow(
  api: TikTokApiService,
  ctx: StoreContext,
  startDate: string,
  endDate: string,
  countCall: (n: number) => void
): Promise<SyncRowCounts> {
  const base = {
    advertiserId: ctx.advertiserId,
    storeId: ctx.storeId,
    storeAuthorizedBcId: ctx.storeAuthorizedBcId,
    startDate,
    endDate,
  };

  // --- campaigns: PRODUCT --------------------------------------------------
  const campaignReport = await api.getReport({
    ...base,
    dimensions: ["campaign_id", "stat_time_day"],
    metrics: CAMPAIGN_METRICS,
    filtering: { gmv_max_promotion_types: ["PRODUCT"] },
  });
  countCall(1);

  const campaignRows = buildCampaignRows(campaignReport.rows, ctx, "PRODUCT");
  const campaignIds = new Set(campaignRows.map((r) => r.campaignId));

  // --- campaigns: LIVE ---
  const liveCampaignReport = await api.getReport({
    ...base,
    dimensions: ["campaign_id", "stat_time_day"],
    metrics: LIVE_CAMPAIGN_METRICS,
    filtering: { gmv_max_promotion_types: ["LIVE"] },
  });
  countCall(1);

  const liveCampaignRows = buildCampaignRows(liveCampaignReport.rows, ctx, "LIVE");
  const liveCampaignIds = new Set(liveCampaignRows.map((r) => r.campaignId));

  await upsert(CampaignDaily, [...campaignRows, ...liveCampaignRows], [
    "storeId",
    "campaignId",
    "statDate",
  ]);

  // --- products, one campaign per call -----------------------------------
  const productRows: ProductDaily[] = [];
  const pairs: { campaignId: string; itemGroupId: string }[] = [];
  const seenPairs = new Set<string>();

  for (const campaignId of campaignIds) {
    const report = await api.getReport({
      ...base,
      dimensions: ["item_group_id", "stat_time_day"],
      metrics: PRODUCT_METRICS,
      filtering: { campaign_ids: [campaignId] },
    });
    countCall(1);

    for (const row of report.rows) {
      const itemGroupId = String(row.dimensions?.item_group_id ?? "");
      const statDate = toDate(row.dimensions?.stat_time_day);
      if (!itemGroupId || !statDate) continue;

      const m = row.metrics ?? {};
      productRows.push({
        storeId: ctx.storeId,
        campaignId,
        itemGroupId,
        statDate,
        advertiserId: ctx.advertiserId,
        productName: attr(m.product_name),
        productStatus: attr(m.product_status),
        productImageUrl: attr(m.product_image_url),
        cost: num(m.cost),
        orders: int(m.orders),
        costPerOrder: num(m.cost_per_order),
        grossRevenue: num(m.gross_revenue),
        roi: num(m.roi),
        syncedAt: new Date(),
      } as ProductDaily);

      const key = `${campaignId}:${itemGroupId}`;
      if (!seenPairs.has(key)) {
        seenPairs.add(key);
        pairs.push({ campaignId, itemGroupId });
      }
    }
  }

  await upsert(ProductDaily, productRows, ["storeId", "campaignId", "itemGroupId", "statDate"]);

  // --- creatives, one (campaign, product) pair per call --------------------
  let creativeCount = 0;

  for (const pair of pairs) {
    const report = await api.getReport({
      ...base,
      dimensions: ["item_id", "stat_time_day"],
      metrics: CREATIVE_METRICS,
      filtering: { campaign_ids: [pair.campaignId], item_group_ids: [pair.itemGroupId] },
    });
    countCall(1);

    const rows = toCreativeRows(report.rows, ctx, pair);
    await upsert(CreativeDaily, rows, [
      "storeId",
      "campaignId",
      "itemGroupId",
      "itemId",
      "statDate",
    ]);
    creativeCount += rows.length;
  }

  // --- live rooms, one LIVE campaign per call ---
  let liveRoomCount = 0;

  for (const campaignId of liveCampaignIds) {
    const report = await api.getReport({
      ...base,
      dimensions: ["room_id", "stat_time_day"],
      metrics: LIVE_ROOM_METRICS,
      filtering: { campaign_ids: [campaignId] },
    });
    countCall(1);

    const rows = buildLiveRoomRows(report.rows, ctx, campaignId);
    await upsert(LiveRoomDaily, rows, ["storeId", "campaignId", "roomId", "statDate"]);
    liveRoomCount += rows.length;
  }

  return {
    campaigns: campaignRows.length,
    liveCampaigns: liveCampaignRows.length,
    products: productRows.length,
    creatives: creativeCount,
    liveRooms: liveRoomCount,
  };
}

function buildCampaignRows(
  rows: ReportRow[],
  ctx: StoreContext,
  promotionType: "PRODUCT" | "LIVE"
): CampaignDaily[] {
  const out: CampaignDaily[] = [];

  for (const row of rows) {
    const campaignId = String(row.dimensions?.campaign_id ?? "");
    const statDate = toDate(row.dimensions?.stat_time_day);
    if (!campaignId || !statDate) continue;

    const m = row.metrics ?? {};
    out.push({
      storeId: ctx.storeId,
      campaignId,
      statDate,
      advertiserId: ctx.advertiserId,
      promotionType,
      campaignName: attr(m.campaign_name),
      operationStatus: attr(m.operation_status),
      bidType: attr(m.bid_type),
      roasBid: num(m.roas_bid),
      targetRoiBudget: num(m.target_roi_budget),
      maxDeliveryBudget: num(m.max_delivery_budget),
      cost: num(m.cost),
      netCost: num(m.net_cost),
      orders: int(m.orders),
      costPerOrder: num(m.cost_per_order),
      grossRevenue: num(m.gross_revenue),
      roi: num(m.roi),
      // LIVE-only fields, undefined for PRODUCT rows
      ttAccountName: attr(m.tt_account_name),
      ttAccountProfileImageUrl: attr(m.tt_account_profile_image_url),
      identityId: attr(m.identity_id),
      liveViews: int(m.live_views),
      costPerLiveView: num(m.cost_per_live_view),
      liveViews10s: int(m["10_second_live_views"]),
      costPerLiveView10s: num(m.cost_per_10_second_live_view),
      liveFollows: int(m.live_follows),
      syncedAt: new Date(),
    } as CampaignDaily);
  }

  return out;
}

function buildLiveRoomRows(rows: ReportRow[], ctx: StoreContext, campaignId: string): LiveRoomDaily[] {
  const out: LiveRoomDaily[] = [];

  for (const row of rows) {
    const roomId = String(row.dimensions?.room_id ?? "");
    const statDate = toDate(row.dimensions?.stat_time_day);
    if (!roomId || !statDate) continue;

    const m = row.metrics ?? {};
    // TikTok returns every room for every day; skip days with no activity
    const cost = num(m.cost);
    const orders = int(m.orders);
    const revenue = num(m.gross_revenue);
    const views = int(m.live_views);
    if ((cost ?? 0) <= 0 && (orders ?? 0) <= 0 && (revenue ?? 0) <= 0 && (views ?? 0) <= 0) continue;

    out.push({
      storeId: ctx.storeId,
      campaignId,
      roomId,
      statDate,
      advertiserId: ctx.advertiserId,
      liveName: attr(m.live_name),
      liveStatus: attr(m.live_status),
      liveLaunchedTime: attr(m.live_launched_time),
      liveDuration: attr(m.live_duration),
      cost: num(m.cost),
      netCost: num(m.net_cost),
      orders: int(m.orders),
      costPerOrder: num(m.cost_per_order),
      grossRevenue: num(m.gross_revenue),
      roi: num(m.roi),
      liveViews: int(m.live_views),
      costPerLiveView: num(m.cost_per_live_view),
      liveViews10s: int(m["10_second_live_views"]),
      costPerLiveView10s: num(m.cost_per_10_second_live_view),
      liveFollows: int(m.live_follows),
      syncedAt: new Date(),
    } as LiveRoomDaily);
  }

  return out;
}

function toCreativeRows(
  rows: ReportRow[],
  ctx: StoreContext,
  pair: { campaignId: string; itemGroupId: string }
): CreativeDaily[] {
  const out: CreativeDaily[] = [];

  for (const row of rows) {
    const itemId = String(row.dimensions?.item_id ?? "");
    const statDate = toDate(row.dimensions?.stat_time_day);
    if (!itemId || !statDate) continue;

    const m = row.metrics ?? {};
    // skip creatives with no cost and no orders
    const cost = num(m.cost);
    const orders = int(m.orders);
    const impressions = int(m.product_impressions);
    if ((cost ?? 0) <= 0 && (orders ?? 0) <= 0 && (impressions ?? 0) <= 0) continue;

    out.push({
      storeId: ctx.storeId,
      campaignId: pair.campaignId,
      itemGroupId: pair.itemGroupId,
      itemId,
      statDate,
      advertiserId: ctx.advertiserId,
      title: attr(m.title),
      ttAccountName: attr(m.tt_account_name),
      ttAccountAuthorizationType: attr(m.tt_account_authorization_type),
      ttAccountProfileImageUrl: attr(m.tt_account_profile_image_url),
      shopContentType: attr(m.shop_content_type),
      creativeDeliveryStatus: attr(m.creative_delivery_status),
      cost,
      orders,
      costPerOrder: num(m.cost_per_order),
      grossRevenue: num(m.gross_revenue),
      roi: num(m.roi),
      productImpressions: impressions,
      productClicks: int(m.product_clicks),
      productClickRate: num(m.product_click_rate),
      adClickRate: num(m.ad_click_rate),
      adConversionRate: num(m.ad_conversion_rate),
      viewRate2s: num(m.ad_video_view_rate_2s),
      viewRate6s: num(m.ad_video_view_rate_6s),
      viewRateP25: num(m.ad_video_view_rate_p25),
      viewRateP50: num(m.ad_video_view_rate_p50),
      viewRateP75: num(m.ad_video_view_rate_p75),
      viewRateP100: num(m.ad_video_view_rate_p100),
      syncedAt: new Date(),
    } as CreativeDaily);
  }

  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsert<T>(entity: new () => T, rows: T[], conflictPaths: string[]): Promise<void> {
  if (rows.length === 0) return;

  // dedupe by key, ON CONFLICT cannot touch the same row twice in one statement
  const deduped = new Map<string, T>();
  for (const row of rows) {
    const key = conflictPaths.map((path) => String((row as Record<string, unknown>)[path])).join(":");
    deduped.set(key, row);
  }
  const dedupedRows = [...deduped.values()];

  const repo = AppDataSource.getRepository(entity);
  for (let i = 0; i < dedupedRows.length; i += UPSERT_BATCH) {
    await repo.upsert(dedupedRows.slice(i, i + UPSERT_BATCH) as never, conflictPaths);
  }
}

// --- helpers ---

/** TikTok returns stat_time_day as "2026-08-16 00:00:00" in the ad account's timezone. */
function toDate(value: MetricValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function num(value: MetricValue | undefined): number | null {
  if (value === undefined || value === null || value === "" || value === "-") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function int(value: MetricValue | undefined): number | null {
  const parsed = num(value);
  return parsed === null ? null : Math.round(parsed);
}

/** "0" and "-1" are TikTok's "not available" sentinels for attribute metrics. */
function attr(value: MetricValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (text === "" || text === "-" || text === "0" || text === "-1") return null;
  return text;
}

/** Report dates follow the ad account's timezone, which for these accounts is Bangkok. */
function todayInAccountTz(): string {
  return new Date(Date.now() + config.sync.tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

function shiftDays(isoDate: string, delta: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
