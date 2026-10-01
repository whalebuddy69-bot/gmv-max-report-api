import { MetricValue, StoreContext, TikTokApiService } from "./tiktokApi.service";
import { logger } from "../utils/logger";

/**
 * Builds report rows from /gmv_max/report/get/:
 *
 *   campaign
 *     └─ product (item_group_id)
 *          ├─ video creative (item_id)
 *          └─ product card (item_id "-1")
 *
 * TikTok only returns attribute metrics (campaign_name, product_name, tt_account_name,
 * ...) when filtering by a single campaign/product id, so those levels are fetched one
 * at a time.
 */

// --- metrics ---

/** dimensions ["campaign_id"], filtering {gmv_max_promotion_types:["PRODUCT"]}. */
export const CAMPAIGN_METRICS = [
  "campaign_id",
  "campaign_name",
  "operation_status",
  "bid_type",
  "roas_bid",
  "target_roi_budget",
  "max_delivery_budget",
  "schedule_type",
  "schedule_start_time",
  "schedule_end_time",
  "cost",
  "net_cost",
  "orders",
  "cost_per_order",
  "gross_revenue",
  "roi",
] as const;

/** dimensions ["item_group_id"], filtering {campaign_ids:[ONE]}. */
export const PRODUCT_METRICS = [
  "item_group_id",
  "product_name",
  "product_image_url",
  "product_status",
  "bid_type",
  "cost",
  "orders",
  "cost_per_order",
  "gross_revenue",
  "roi",
] as const;

/** dimensions ["item_id"], filtering {campaign_ids:[ONE], item_group_ids:[ONE]}. */
export const CREATIVE_METRICS = [
  "item_id",
  "title",
  "tt_account_name",
  "tt_account_authorization_type",
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

/** dimensions ["advertiser_id"], a cross-check that sums the campaign sheet. */
export const ACCOUNT_METRICS = [
  "cost",
  "net_cost",
  "orders",
  "cost_per_order",
  "gross_revenue",
  "roi",
] as const;

/** item_id of the product card creative. */
export const PRODUCT_CARD_ITEM_ID = "-1";

// --- types ---

export interface CampaignRow {
  campaignId: string;
  campaignName: string;
  status: string;
  bidType: string;
  roiTarget: number | null;
  targetRoiBudget: number | null;
  maxDeliveryBudget: number | null;
  scheduleStart: string;
  scheduleEnd: string;
  cost: number | null;
  netCost: number | null;
  orders: number | null;
  costPerOrder: number | null;
  grossRevenue: number | null;
  roi: number | null;
}

export interface ProductByCampaignRow {
  campaignId: string;
  campaignName: string;
  productId: string;
  productName: string;
  productStatus: string;
  cost: number | null;
  orders: number | null;
  costPerOrder: number | null;
  grossRevenue: number | null;
  roi: number | null;
}

export type CreativeKind = "วิดีโอ" | "การ์ดสินค้า";

export interface CreativeRow {
  campaignId: string;
  campaignName: string;
  productId: string;
  productName: string;
  creativeType: CreativeKind;
  videoId: string;
  /** tt_account_name, the TikTok account that posted the video. */
  tiktokAccount: string;
  /** TTS_TT | AFFILIATE | TT_USER | BC_AUTH_TT | AUTH_CODE | UNSET */
  authorizationType: string;
  deliveryStatus: string;
  title: string;
  cost: number | null;
  orders: number | null;
  costPerOrder: number | null;
  grossRevenue: number | null;
  roi: number | null;
  productImpressions: number | null;
  productClicks: number | null;
  productClickRate: number | null;
  adClickRate: number | null;
  adConversionRate: number | null;
  viewRate2s: number | null;
  viewRate6s: number | null;
  viewRateP25: number | null;
  viewRateP50: number | null;
  viewRateP75: number | null;
  viewRateP100: number | null;
}

export interface BuiltReport {
  campaigns: CampaignRow[];
  productsByCampaign: ProductByCampaignRow[];
  creatives: CreativeRow[];
  warnings: string[];
  accountTotals: Record<string, MetricValue>;
  currency: string;
  stats: {
    campaignsTotal: number;
    campaignsReported: number;
    products: number;
    creatives: number;
    productCards: number;
    creativesDroppedZero: number;
    rowsWithAccountName: number;
    apiCalls: number;
  };
}

export interface BuildOptions {
  startDate: string;
  endDate: string;
  /** Restrict to these campaigns. Default: every campaign with cost > 0 in the window. */
  campaignIds?: string[];
  /** Include creatives with no cost and no orders. Default false. */
  includeZeroCost?: boolean;
}

// --- build ---

export async function buildReport(
  api: TikTokApiService,
  ctx: StoreContext,
  options: BuildOptions
): Promise<BuiltReport> {
  const warnings: string[] = [];
  let apiCalls = 0;
  // currency is only present on some rows; take the first one found
  let currency = "";
  const noteCurrency = (metrics: Record<string, MetricValue> | undefined) => {
    if (!currency) currency = attr(metrics?.currency);
  };

  const base = {
    advertiserId: ctx.advertiserId,
    storeId: ctx.storeId,
    storeAuthorizedBcId: ctx.storeAuthorizedBcId,
    startDate: options.startDate,
    endDate: options.endDate,
  };

  // --- Step 1: campaigns ---------------------------------------------------
  const campaignReport = await api.getReport({
    ...base,
    dimensions: ["campaign_id"],
    metrics: CAMPAIGN_METRICS,
    filtering: { gmv_max_promotion_types: ["PRODUCT"] },
  });
  apiCalls += 1;

  const allCampaigns: CampaignRow[] = campaignReport.rows
    .filter((row) => row?.dimensions?.campaign_id)
    .map((row) => {
      const m = row.metrics ?? {};
      noteCurrency(m);
      return {
        campaignId: String(row.dimensions.campaign_id),
        campaignName: attr(m.campaign_name),
        status: attr(m.operation_status),
        bidType: attr(m.bid_type),
        roiTarget: toNumber(m.roas_bid),
        targetRoiBudget: toNumber(m.target_roi_budget),
        maxDeliveryBudget: toNumber(m.max_delivery_budget),
        scheduleStart: attr(m.schedule_start_time),
        scheduleEnd: attr(m.schedule_end_time),
        cost: toNumber(m.cost),
        netCost: toNumber(m.net_cost),
        orders: toNumber(m.orders),
        costPerOrder: toNumber(m.cost_per_order),
        grossRevenue: toNumber(m.gross_revenue),
        roi: toNumber(m.roi),
      };
    });

  const requested = options.campaignIds?.filter(Boolean) ?? [];
  let campaigns: CampaignRow[];

  if (requested.length > 0) {
    const known = new Set(allCampaigns.map((c) => c.campaignId));
    const missing = requested.filter((id) => !known.has(id));
    if (missing.length > 0) {
      warnings.push(
        `ไม่พบแคมเปญ ${missing.join(", ")} ในร้านนี้/ช่วงวันที่นี้, ` +
          `แคมเปญที่มี: ${allCampaigns.map((c) => `${c.campaignName} (${c.campaignId})`).join(", ") || "ไม่มีเลย"}`
      );
    }
    campaigns = allCampaigns.filter((c) => requested.includes(c.campaignId));
  } else {
    campaigns = allCampaigns.filter((c) => (c.cost ?? 0) > 0);
    const idle = allCampaigns.length - campaigns.length;
    if (idle > 0) {
      warnings.push(
        `ข้าม ${idle} แคมเปญที่ไม่มีค่าใช้จ่ายในช่วงนี้, ระบุ campaignIds ใน request เพื่อบังคับให้รวมเข้ามา`
      );
    }
  }

  if (campaigns.length === 0) {
    warnings.push(`ไม่มีแคมเปญให้รายงานในช่วง ${options.startDate}..${options.endDate}`);
  }

  // Step 2: products, one campaign per call
  const productsByCampaign: ProductByCampaignRow[] = [];

  for (const campaign of campaigns) {
    const report = await api.getReport({
      ...base,
      dimensions: ["item_group_id"],
      metrics: PRODUCT_METRICS,
      filtering: { campaign_ids: [campaign.campaignId] },
    });
    apiCalls += 1;

    for (const row of report.rows) {
      const productId = String(row.dimensions?.item_group_id ?? "");
      if (!productId) continue;
      const m = row.metrics ?? {};
      noteCurrency(m);
      productsByCampaign.push({
        campaignId: campaign.campaignId,
        campaignName: campaign.campaignName,
        productId,
        productName: attr(m.product_name),
        productStatus: attr(m.product_status),
        cost: toNumber(m.cost),
        orders: toNumber(m.orders),
        costPerOrder: toNumber(m.cost_per_order),
        grossRevenue: toNumber(m.gross_revenue),
        roi: toNumber(m.roi),
      });
    }
  }

  // --- Step 3: creatives, one (campaign, product) pair per call ------------
  const creatives: CreativeRow[] = [];
  let creativesDroppedZero = 0;

  for (const product of productsByCampaign) {
    const report = await api.getReport({
      ...base,
      dimensions: ["item_id"],
      metrics: CREATIVE_METRICS,
      filtering: {
        campaign_ids: [product.campaignId],
        item_group_ids: [product.productId],
      },
    });
    apiCalls += 1;

    for (const row of report.rows) {
      const m = row.metrics ?? {};
      noteCurrency(m);
      const cost = toNumber(m.cost);
      const orders = toNumber(m.orders);
      if ((cost ?? 0) <= 0 && (orders ?? 0) <= 0 && !options.includeZeroCost) {
        creativesDroppedZero += 1;
        continue;
      }

      const itemId = String(row.dimensions?.item_id ?? "");
      const isCard = itemId === PRODUCT_CARD_ITEM_ID || attr(m.shop_content_type) === "PRODUCT_CARD";

      creatives.push({
        campaignId: product.campaignId,
        campaignName: product.campaignName,
        productId: product.productId,
        productName: product.productName,
        creativeType: isCard ? "การ์ดสินค้า" : "วิดีโอ",
        videoId: isCard ? "" : itemId,
        tiktokAccount: attr(m.tt_account_name),
        authorizationType: attr(m.tt_account_authorization_type),
        deliveryStatus: attr(m.creative_delivery_status),
        title: attr(m.title),
        cost,
        orders,
        costPerOrder: toNumber(m.cost_per_order),
        grossRevenue: toNumber(m.gross_revenue),
        roi: toNumber(m.roi),
        productImpressions: toNumber(m.product_impressions),
        productClicks: toNumber(m.product_clicks),
        productClickRate: toNumber(m.product_click_rate),
        adClickRate: toNumber(m.ad_click_rate),
        adConversionRate: toNumber(m.ad_conversion_rate),
        viewRate2s: toNumber(m.ad_video_view_rate_2s),
        viewRate6s: toNumber(m.ad_video_view_rate_6s),
        viewRateP25: toNumber(m.ad_video_view_rate_p25),
        viewRateP50: toNumber(m.ad_video_view_rate_p50),
        viewRateP75: toNumber(m.ad_video_view_rate_p75),
        viewRateP100: toNumber(m.ad_video_view_rate_p100),
      });
    }
  }

  // --- Step 4: account totals ---------------------------------------------
  const accountReport = await api.getReport({
    ...base,
    dimensions: ["advertiser_id"],
    metrics: ACCOUNT_METRICS,
  });
  apiCalls += 1;

  for (const dropped of [
    { level: "Campaign", metrics: campaignReport.droppedMetrics },
    { level: "Account", metrics: accountReport.droppedMetrics },
  ]) {
    if (dropped.metrics.length > 0) {
      warnings.push(
        `TikTok ปฏิเสธ metric ที่ระดับ ${dropped.level}: ${dropped.metrics.join(", ")}, คอลัมน์เหล่านี้จะว่าง`
      );
    }
  }

  if (creativesDroppedZero > 0) {
    warnings.push(
      `ซ่อน ${creativesDroppedZero} ชิ้นงานที่ไม่มีค่าใช้จ่ายและไม่มีคำสั่งซื้อ, ` +
        `ส่ง includeZeroCost=true ใน request ถ้าต้องการเห็นทั้งหมด`
    );
  }

  const rowsWithAccountName = creatives.filter(
    (r) => r.creativeType === "วิดีโอ" && r.tiktokAccount !== ""
  ).length;
  const videoRows = creatives.filter((r) => r.creativeType === "วิดีโอ").length;

  if (videoRows > 0 && rowsWithAccountName < videoRows) {
    // "0" / "-1" means no permission for that account; attr() blanks them
    warnings.push(
      `${videoRows - rowsWithAccountName} จาก ${videoRows} แถววิดีโอไม่มีชื่อบัญชี TikTok, ` +
        `ตามเอกสารคือ access token ไม่มีสิทธิ์เข้าถึงบัญชีนั้น (API ส่ง "0" หรือ "-1" กลับมา)`
    );
  }

  const productCards = creatives.filter((r) => r.creativeType === "การ์ดสินค้า").length;

  campaigns.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
  productsByCampaign.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
  creatives.sort(
    (a, b) =>
      a.campaignId.localeCompare(b.campaignId) ||
      a.productId.localeCompare(b.productId) ||
      (b.cost ?? 0) - (a.cost ?? 0)
  );

  noteCurrency(accountReport.rows[0]?.metrics);

  logger.info("Report assembled", {
    storeId: ctx.storeId,
    campaigns: campaigns.length,
    products: productsByCampaign.length,
    creatives: creatives.length,
    productCards,
    apiCalls,
  });

  return {
    campaigns,
    productsByCampaign,
    creatives,
    warnings,
    accountTotals: accountReport.rows[0]?.metrics ?? {},
    currency,
    stats: {
      campaignsTotal: allCampaigns.length,
      campaignsReported: campaigns.length,
      products: productsByCampaign.length,
      creatives: creatives.length,
      productCards,
      creativesDroppedZero,
      rowsWithAccountName,
      apiCalls,
    },
  };
}

// --- helpers ---

/** TikTok returns metrics as strings ("12.34") and uses "-" for "no data". */
function toNumber(value: MetricValue | undefined): number | null {
  if (value === undefined || value === null || value === "" || value === "-") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** "0" and "-1" mean "not available" for attribute metrics. */
function attr(value: MetricValue | undefined): string {
  if (value === undefined || value === null) return "";
  const text = String(value);
  if (text === "" || text === "-" || text === "0" || text === "-1") return "";
  return text;
}
