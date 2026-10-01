import { Column, Entity, Index, PrimaryColumn } from "typeorm";
import { bigintTransformer, numericTransformer } from "./numeric";

/** One row per campaign per day. */
@Entity({ name: "report_campaign_daily" })
@Index(["statDate", "storeId"])
export class CampaignDaily {
  @PrimaryColumn({ name: "store_id", type: "text" })
  storeId!: string;

  @PrimaryColumn({ name: "campaign_id", type: "text" })
  campaignId!: string;

  /** YYYY-MM-DD in the ad account timezone. */
  @PrimaryColumn({ name: "stat_date", type: "date" })
  statDate!: string;

  @Column({ name: "advertiser_id", type: "text" })
  advertiserId!: string;

  /** PRODUCT | LIVE */
  @Column({ name: "promotion_type", type: "text", default: "PRODUCT" })
  promotionType!: string;

  @Column({ name: "campaign_name", type: "text", nullable: true })
  campaignName?: string | null;

  @Column({ name: "operation_status", type: "text", nullable: true })
  operationStatus?: string | null;

  @Column({ name: "bid_type", type: "text", nullable: true })
  bidType?: string | null;

  @Column({ name: "roas_bid", type: "numeric", nullable: true, transformer: numericTransformer })
  roasBid?: number | null;

  @Column({ name: "target_roi_budget", type: "numeric", nullable: true, transformer: numericTransformer })
  targetRoiBudget?: number | null;

  @Column({ name: "max_delivery_budget", type: "numeric", nullable: true, transformer: numericTransformer })
  maxDeliveryBudget?: number | null;

  @Column({ type: "numeric", nullable: true, transformer: numericTransformer })
  cost?: number | null;

  @Column({ name: "net_cost", type: "numeric", nullable: true, transformer: numericTransformer })
  netCost?: number | null;

  @Column({ type: "int", nullable: true })
  orders?: number | null;

  @Column({ name: "cost_per_order", type: "numeric", nullable: true, transformer: numericTransformer })
  costPerOrder?: number | null;

  @Column({ name: "gross_revenue", type: "numeric", nullable: true, transformer: numericTransformer })
  grossRevenue?: number | null;

  @Column({ type: "numeric", nullable: true, transformer: numericTransformer })
  roi?: number | null;

  // LIVE campaigns only; null for PRODUCT rows.

  @Column({ name: "tt_account_name", type: "text", nullable: true })
  ttAccountName?: string | null;

  @Column({ name: "tt_account_profile_image_url", type: "text", nullable: true })
  ttAccountProfileImageUrl?: string | null;

  @Column({ name: "identity_id", type: "text", nullable: true })
  identityId?: string | null;

  @Column({ name: "live_views", type: "bigint", nullable: true, transformer: bigintTransformer })
  liveViews?: number | null;

  @Column({ name: "cost_per_live_view", type: "numeric", nullable: true, transformer: numericTransformer })
  costPerLiveView?: number | null;

  /** TikTok field: 10_second_live_views */
  @Column({ name: "live_views_10s", type: "bigint", nullable: true, transformer: bigintTransformer })
  liveViews10s?: number | null;

  @Column({ name: "cost_per_live_view_10s", type: "numeric", nullable: true, transformer: numericTransformer })
  costPerLiveView10s?: number | null;

  @Column({ name: "live_follows", type: "int", nullable: true })
  liveFollows?: number | null;

  @Column({ name: "synced_at", type: "timestamptz", default: () => "now()" })
  syncedAt!: Date;
}
