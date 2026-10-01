import { Column, Entity, PrimaryColumn } from "typeorm";

/**
 * Partial mapping of the telegram bot's oauth_tokens table. The bot owns the schema,
 * so only the columns used here are declared.
 */
@Entity({ name: "oauth_tokens" })
export class OAuthToken {
  @PrimaryColumn({ type: "uuid" })
  id!: string;

  @Column({ name: "advertiser_id" })
  advertiserId!: string;

  /** Encrypted, see utils/crypto.ts */
  @Column({ name: "access_token", type: "text" })
  accessTokenEncrypted!: string;

  // timestamp without time zone in the bot schema (revoked_at is timestamptz)
  @Column({ name: "authorized_at", type: "timestamp" })
  authorizedAt!: Date;

  @Column({ name: "revoked_at", type: "timestamptz", nullable: true })
  revokedAt?: Date | null;
}
