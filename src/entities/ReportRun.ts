import { Column, CreateDateColumn, Entity, PrimaryColumn } from "typeorm";

export type ReportRunStatus = "pending" | "success" | "failed";

export interface ReportRowCounts {
  campaigns: number;
  products: number;
  creatives: number;
  productCards: number;
  rowsWithAccountName: number;
}

@Entity({ name: "report_runs" })
export class ReportRun {
  @PrimaryColumn({ type: "uuid" })
  id!: string;

  @Column({ name: "advertiser_id" })
  advertiserId!: string;

  @Column({ name: "store_ids", type: "jsonb", default: () => "'[]'::jsonb" })
  storeIds!: string[];

  @Column({ name: "start_date", type: "date" })
  startDate!: string;

  @Column({ name: "end_date", type: "date" })
  endDate!: string;

  @Column({ type: "text" })
  status!: ReportRunStatus;

  @Column({ name: "file_path", type: "text", nullable: true })
  filePath?: string | null;

  @Column({ name: "file_name", type: "text", nullable: true })
  fileName?: string | null;

  @Column({ name: "row_counts", type: "jsonb", nullable: true })
  rowCounts?: ReportRowCounts | null;

  @Column({ type: "jsonb", nullable: true })
  warnings?: string[] | null;

  @Column({ name: "error_message", type: "text", nullable: true })
  errorMessage?: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @Column({ name: "generated_at", type: "timestamptz", nullable: true })
  generatedAt?: Date | null;
}
