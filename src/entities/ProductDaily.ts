import { Column, Entity, Index, PrimaryColumn } from "typeorm";
import { numericTransformer } from "./numeric";

/** One row per campaign/product per day. */
@Entity({ name: "report_product_daily" })
@Index(["statDate", "storeId"])
export class ProductDaily {
  @PrimaryColumn({ name: "store_id", type: "text" })
  storeId!: string;

  @PrimaryColumn({ name: "campaign_id", type: "text" })
  campaignId!: string;

  @PrimaryColumn({ name: "item_group_id", type: "text" })
  itemGroupId!: string;

  @PrimaryColumn({ name: "stat_date", type: "date" })
  statDate!: string;

  @Column({ name: "advertiser_id", type: "text" })
  advertiserId!: string;

  @Column({ name: "product_name", type: "text", nullable: true })
  productName?: string | null;

  @Column({ name: "product_status", type: "text", nullable: true })
  productStatus?: string | null;

  @Column({ name: "product_image_url", type: "text", nullable: true })
  productImageUrl?: string | null;

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

  @Column({ name: "synced_at", type: "timestamptz", default: () => "now()" })
  syncedAt!: Date;
}
