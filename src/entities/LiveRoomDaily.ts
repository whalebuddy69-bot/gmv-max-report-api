import { Column, Entity, Index, PrimaryColumn } from "typeorm";
import { bigintTransformer, numericTransformer } from "./numeric";

/** One row per LIVE room per day (LIVE GMV Max only). */
@Entity({ name: "report_live_room_daily" })
@Index(["statDate", "storeId"])
export class LiveRoomDaily {
  @PrimaryColumn({ name: "store_id", type: "text" })
  storeId!: string;

  @PrimaryColumn({ name: "campaign_id", type: "text" })
  campaignId!: string;

  @PrimaryColumn({ name: "room_id", type: "text" })
  roomId!: string;

  @PrimaryColumn({ name: "stat_date", type: "date" })
  statDate!: string;

  @Column({ name: "advertiser_id", type: "text" })
  advertiserId!: string;

  @Column({ name: "live_name", type: "text", nullable: true })
  liveName?: string | null;

  /** ONGOING | END */
  @Column({ name: "live_status", type: "text", nullable: true })
  liveStatus?: string | null;

  /** Raw value from TikTok, not guaranteed to be ISO. */
  @Column({ name: "live_launched_time", type: "text", nullable: true })
  liveLaunchedTime?: string | null;

  /** Pre-formatted by TikTok, e.g. "14h 1m". */
  @Column({ name: "live_duration", type: "text", nullable: true })
  liveDuration?: string | null;

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
