import { Column, Entity, Index, PrimaryColumn } from "typeorm";
import { bigintTransformer, numericTransformer } from "./numeric";

/** One row per creative per day. itemId is "-1" for the product card. */
@Entity({ name: "report_creative_daily" })
@Index(["statDate", "storeId"])
export class CreativeDaily {
  @PrimaryColumn({ name: "store_id", type: "text" })
  storeId!: string;

  @PrimaryColumn({ name: "campaign_id", type: "text" })
  campaignId!: string;

  @PrimaryColumn({ name: "item_group_id", type: "text" })
  itemGroupId!: string;

  @PrimaryColumn({ name: "item_id", type: "text" })
  itemId!: string;

  @PrimaryColumn({ name: "stat_date", type: "date" })
  statDate!: string;

  @Column({ name: "advertiser_id", type: "text" })
  advertiserId!: string;

  @Column({ type: "text", nullable: true })
  title?: string | null;

  @Column({ name: "tt_account_name", type: "text", nullable: true })
  ttAccountName?: string | null;

  @Column({ name: "tt_account_authorization_type", type: "text", nullable: true })
  ttAccountAuthorizationType?: string | null;

  /** Creator avatar (the API has no video thumbnail). */
  @Column({ name: "tt_account_profile_image_url", type: "text", nullable: true })
  ttAccountProfileImageUrl?: string | null;

  /** VIDEO | PRODUCT_CARD */
  @Column({ name: "shop_content_type", type: "text", nullable: true })
  shopContentType?: string | null;

  @Column({ name: "creative_delivery_status", type: "text", nullable: true })
  creativeDeliveryStatus?: string | null;

  @Column({ type: "numeric", nullable: true, transformer: numericTransformer })
  cost?: number | null;

  @Column({ type: "int", nullable: true })
  orders?: number | null;

  @Column({ name: "cost_per_order", type: "numeric", nullable: true, transformer: numericTransformer })
  costPerOrder?: number | null;

  @Column({ name: "gross_revenue", type: "numeric", nullable: true, transformer: numericTransformer })
  grossRevenue?: number | null;

  @Column({ type: "numeric", nullable: true, transformer: numericTransformer })
  roi?: number | null;

  @Column({ name: "product_impressions", type: "bigint", nullable: true, transformer: bigintTransformer })
  productImpressions?: number | null;

  @Column({ name: "product_clicks", type: "bigint", nullable: true, transformer: bigintTransformer })
  productClicks?: number | null;

  @Column({ name: "product_click_rate", type: "numeric", nullable: true, transformer: numericTransformer })
  productClickRate?: number | null;

  @Column({ name: "ad_click_rate", type: "numeric", nullable: true, transformer: numericTransformer })
  adClickRate?: number | null;

  @Column({ name: "ad_conversion_rate", type: "numeric", nullable: true, transformer: numericTransformer })
  adConversionRate?: number | null;

  @Column({ name: "ad_video_view_rate_2s", type: "numeric", nullable: true, transformer: numericTransformer })
  viewRate2s?: number | null;

  @Column({ name: "ad_video_view_rate_6s", type: "numeric", nullable: true, transformer: numericTransformer })
  viewRate6s?: number | null;

  @Column({ name: "ad_video_view_rate_p25", type: "numeric", nullable: true, transformer: numericTransformer })
  viewRateP25?: number | null;

  @Column({ name: "ad_video_view_rate_p50", type: "numeric", nullable: true, transformer: numericTransformer })
  viewRateP50?: number | null;

  @Column({ name: "ad_video_view_rate_p75", type: "numeric", nullable: true, transformer: numericTransformer })
  viewRateP75?: number | null;

  @Column({ name: "ad_video_view_rate_p100", type: "numeric", nullable: true, transformer: numericTransformer })
  viewRateP100?: number | null;

  @Column({ name: "synced_at", type: "timestamptz", default: () => "now()" })
  syncedAt!: Date;
}
