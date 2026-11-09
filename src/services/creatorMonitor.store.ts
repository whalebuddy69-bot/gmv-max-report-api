import { verifiedTikTokUsername } from "./creatorIdentityUsername.service";
import { CREATOR_BINDING } from "./creatorRead.service";
import type { CreatorWebBudgetDatabase } from "./creatorWebBudget.store";

export const CREATOR_MONITOR_LIMIT = 12;
export const monitorResourceId = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{5,30}$/.test(value);
export type CreatorMonitorRecord = {
  advertiserId: string; campaignId: string; tiktokUsername: string; tiktokAccountId: string | null;
  identityId: string; identityType: "BC_AUTH_TT"; identityAuthorizedBcId: string; credentialAdvertiserId: string;
};

export const CREATOR_MONITOR_SCHEMA = `CREATE TABLE IF NOT EXISTS creator_monitor_enrollments (
  owner_id bigint NOT NULL CHECK (owner_id > 0),
  advertiser_id text NOT NULL CHECK (advertiser_id ~ '^[1-9][0-9]{5,30}$'),
  initial_campaign_id text NOT NULL CHECK (initial_campaign_id ~ '^[1-9][0-9]{5,30}$'),
  tiktok_username text NOT NULL CHECK (tiktok_username ~ '^[A-Za-z0-9._]{1,24}$'),
  tiktok_account_id text CHECK (tiktok_account_id ~ '^[1-9][0-9]{5,30}$'),
  identity_id text NOT NULL CHECK (identity_id ~ '^[A-Za-z0-9_-]{6,100}$'),
  identity_authorized_bc_id text NOT NULL CHECK (identity_authorized_bc_id ~ '^[1-9][0-9]{5,30}$'),
  credential_advertiser_id text NOT NULL CHECK (credential_advertiser_id ~ '^[1-9][0-9]{5,30}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, advertiser_id)
);`;

type Row = Record<string, unknown>;
function parse(row: Row): CreatorMonitorRecord {
  const { advertiser_id, initial_campaign_id, tiktok_username, tiktok_account_id, identity_id, identity_authorized_bc_id, credential_advertiser_id } = row;
  const username = verifiedTikTokUsername(tiktok_username);
  if (!monitorResourceId(advertiser_id) || !monitorResourceId(initial_campaign_id) || !username ||
    !(tiktok_account_id === null || monitorResourceId(tiktok_account_id)) || !monitorResourceId(credential_advertiser_id) ||
    typeof identity_id !== "string" || !/^[A-Za-z0-9_-]{6,100}$/.test(identity_id) || /^0+$/.test(identity_id) ||
    identity_authorized_bc_id !== CREATOR_BINDING.identityAuthorizedBcId) throw new Error("MONITOR_RECORD_INVALID");
  return { advertiserId: advertiser_id, campaignId: initial_campaign_id, tiktokUsername: username, tiktokAccountId: tiktok_account_id,
    identityId: identity_id, identityType: "BC_AUTH_TT", identityAuthorizedBcId: identity_authorized_bc_id, credentialAdvertiserId: credential_advertiser_id };
}

export function createCreatorMonitorStore(database: CreatorWebBudgetDatabase) {
  async function transaction<T>(operation: (runner: ReturnType<CreatorWebBudgetDatabase["createQueryRunner"]>) => Promise<T>, readOnly = false): Promise<T> {
    const runner = database.createQueryRunner();
    try {
      await runner.connect();
      await runner.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
      await runner.query("SET LOCAL statement_timeout = '5s'");
      const result = await operation(runner);
      await runner.query("COMMIT");
      return result;
    } catch (error) {
      await runner.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { await runner.release(); }
  }
  async function read(runner: ReturnType<CreatorWebBudgetDatabase["createQueryRunner"]>, owner: number): Promise<CreatorMonitorRecord[]> {
    if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error("MONITOR_OWNER_INVALID");
    const rows = await runner.query(`SELECT advertiser_id, initial_campaign_id, tiktok_username, tiktok_account_id, identity_id,
      identity_authorized_bc_id, credential_advertiser_id FROM creator_monitor_enrollments WHERE owner_id = $1
      ORDER BY created_at, advertiser_id LIMIT $2`, [owner, CREATOR_MONITOR_LIMIT]);
    if (!Array.isArray(rows)) throw new Error("MONITOR_STORE_UNAVAILABLE");
    return rows.map(parse);
  }
  return {
    ensureSchema: () => transaction(async runner => {
      await runner.query("SELECT pg_advisory_xact_lock(821903780, 1)");
      await runner.query(CREATOR_MONITOR_SCHEMA);
    }),
    list: (owner: number) => transaction(runner => read(runner, owner), true),
    add: (owner: number, proof: CreatorMonitorRecord) => transaction(async runner => {
      if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error("MONITOR_OWNER_INVALID");
      // Distinct namespace from ad writers; locks only enrollment within this owner.
      await runner.query("SELECT pg_advisory_xact_lock(821903781, hashtext($1::text))", [String(owner)]);
      const records = await read(runner, owner);
      const existing = records.find(row => row.advertiserId === proof.advertiserId);
      if (existing) return existing.identityId === proof.identityId && existing.identityAuthorizedBcId === proof.identityAuthorizedBcId
        && (existing.tiktokAccountId === null || proof.tiktokAccountId === null || existing.tiktokAccountId === proof.tiktokAccountId)
        ? "existing" as const : "conflict" as const;
      if (records.length >= CREATOR_MONITOR_LIMIT) return "limit" as const;
      await runner.query(`INSERT INTO creator_monitor_enrollments (owner_id, advertiser_id, initial_campaign_id, tiktok_username,
        tiktok_account_id, identity_id, identity_authorized_bc_id, credential_advertiser_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [owner, proof.advertiserId, proof.campaignId, proof.tiktokUsername, proof.tiktokAccountId, proof.identityId,
          proof.identityAuthorizedBcId, proof.credentialAdvertiserId]);
      return "created" as const;
    }),
  };
}
