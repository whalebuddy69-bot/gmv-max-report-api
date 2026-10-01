import { Column, CreateDateColumn, Entity, PrimaryColumn } from "typeorm";

/** One-time state for the web TikTok OAuth flow. Deleted when the callback uses it. */
@Entity({ name: "web_oauth_states" })
export class WebOAuthState {
  @PrimaryColumn({ type: "text" })
  state!: string;

  @Column({ name: "target_advertiser_id", type: "text" })
  targetAdvertiserId!: string;

  @Column({ name: "store_id", type: "text", nullable: true })
  storeId?: string | null;

  @Column({ name: "created_by_user_id", type: "integer", nullable: true })
  createdByUserId?: number | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @Column({ name: "expires_at", type: "timestamptz" })
  expiresAt!: Date;
}
