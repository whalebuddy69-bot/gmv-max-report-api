import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from "typeorm";

/**
 * Advertiser/store pairs pulled by the sync cron. Discovery never overwrites `enabled`,
 * so a store switched off by hand stays off.
 */
@Entity({ name: "sync_targets" })
@Unique(["advertiserId", "storeId"])
export class SyncTarget {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: "advertiser_id", type: "text" })
  advertiserId!: string;

  @Column({ name: "store_id", type: "text" })
  storeId!: string;

  @Column({ name: "store_name", type: "text", nullable: true })
  storeName?: string | null;

  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  @Column({ name: "last_synced_at", type: "timestamptz", nullable: true })
  lastSyncedAt?: Date | null;

  @Column({ name: "last_error", type: "text", nullable: true })
  lastError?: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
