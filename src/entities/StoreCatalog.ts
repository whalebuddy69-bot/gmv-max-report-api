import { Column, Entity, Index, PrimaryColumn } from "typeorm";

/**
 * Latest /gmv_max/store/list/ result per advertiser/store, including stores that
 * are not sync targets. Written by discoverSyncTargets().
 */
@Entity({ name: "store_catalog" })
@Index(["storeId"])
export class StoreCatalog {
  @PrimaryColumn({ name: "advertiser_id", type: "text" })
  advertiserId!: string;

  @PrimaryColumn({ name: "store_id", type: "text" })
  storeId!: string;

  @Column({ name: "store_name", type: "text", nullable: true })
  storeName?: string | null;

  @Column({ name: "store_code", type: "text", nullable: true })
  storeCode?: string | null;

  @Column({ name: "is_gmv_max_available", type: "boolean", default: false })
  isGmvMaxAvailable!: boolean;

  @Column({ name: "store_status", type: "text", nullable: true })
  storeStatus?: string | null;

  @Column({ name: "exclusive_advertiser_id", type: "text", nullable: true })
  exclusiveAdvertiserId?: string | null;

  @Column({ name: "exclusive_advertiser_name", type: "text", nullable: true })
  exclusiveAdvertiserName?: string | null;

  @Column({ name: "store_authorized_bc_id", type: "text", nullable: true })
  storeAuthorizedBcId?: string | null;

  @Column({ name: "bc_name", type: "text", nullable: true })
  bcName?: string | null;

  @Column({ name: "seen_at", type: "timestamptz", default: () => "now()" })
  seenAt!: Date;
}
