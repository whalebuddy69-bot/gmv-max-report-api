import { Column, CreateDateColumn, Entity, PrimaryColumn } from "typeorm";

export type SyncStatus = "running" | "success" | "failed";

export interface SyncRowCounts {
  campaigns: number;
  liveCampaigns: number;
  products: number;
  creatives: number;
  liveRooms: number;
}

/** One row per sync attempt. */
@Entity({ name: "sync_runs" })
export class SyncRun {
  @PrimaryColumn({ type: "uuid" })
  id!: string;

  @Column({ name: "advertiser_id", type: "text" })
  advertiserId!: string;

  @Column({ name: "store_id", type: "text" })
  storeId!: string;

  @Column({ name: "start_date", type: "date" })
  startDate!: string;

  @Column({ name: "end_date", type: "date" })
  endDate!: string;

  @Column({ type: "text" })
  status!: SyncStatus;

  @Column({ name: "api_calls", type: "int", default: 0 })
  apiCalls!: number;

  @Column({ name: "row_counts", type: "jsonb", nullable: true })
  rowCounts?: SyncRowCounts | null;

  @Column({ name: "error_message", type: "text", nullable: true })
  errorMessage?: string | null;

  @CreateDateColumn({ name: "started_at", type: "timestamptz" })
  startedAt!: Date;

  @Column({ name: "finished_at", type: "timestamptz", nullable: true })
  finishedAt?: Date | null;
}
