import type { CreativeDaily } from "../entities/CreativeDaily";
import type { MetricValue, ReportRow, StoreContext } from "./tiktokApi.service";

/**
 * Preserve every valid daily row returned by TikTok, including creatives awaiting
 * delivery. Absence of activity is not absence of a creative or its status.
 * This is not an inventory API: never invent rows/dates that TikTok did not return.
 */
export function toCreativeRows(
  rows: ReportRow[],
  ctx: StoreContext,
  pair: { campaignId: string; itemGroupId: string },
  syncedAt: Date = new Date(),
): CreativeDaily[] {
  const out: CreativeDaily[] = [];

  for (const row of rows) {
    const itemId = toItemId(row.dimensions?.item_id);
    const statDate = toReportDate(row.dimensions?.stat_time_day);
    if (!itemId || !statDate) continue;

    const m = row.metrics ?? {};
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
      cost: num(m.cost),
      orders: int(m.orders),
      costPerOrder: num(m.cost_per_order),
      grossRevenue: num(m.gross_revenue),
      roi: num(m.roi),
      productImpressions: int(m.product_impressions),
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
      syncedAt,
    } as CreativeDaily);
  }

  return out;
}

function toItemId(value: MetricValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  // Large TikTok IDs must arrive as strings; an unsafe numeric ID is already lossy.
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
  const text = String(value);
  // -1 is TikTok's product-card identity, not a missing attribute sentinel here.
  return text === "-1" || /^[1-9]\d*$/.test(text) ? text : null;
}

/** Keep the reporting day in the ad account timezone, without UTC conversion. */
function toReportDate(value: MetricValue | undefined): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:$|[ T])/.test(value)) return null;
  const day = value.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null;
}

function num(value: MetricValue | undefined): number | null {
  if (value === undefined || value === null || value === "-" || (typeof value === "string" && !value.trim())) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function int(value: MetricValue | undefined): number | null {
  const parsed = num(value);
  return parsed === null ? null : Math.round(parsed);
}

/** Attribute sentinels must not be interpreted as an actual creator/status. */
function attr(value: MetricValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (text === "" || text === "-" || text === "0" || text === "-1") return null;
  return text;
}
