import type { CreatorWebBudgetDatabase } from "./creatorWebBudget.store";
import type { CampaignAction, CampaignActionOutcome, CampaignActionTarget } from "./creatorCampaignActions.provider";

export const PPAN_CAMPAIGN_OPERATIONS = "creator_ppan_campaign_action_operations";
// Both Ppan writer reservations take this same transaction lock before checking the other ledger.
export const PPAN_CAMPAIGN_BUDGET_LOCK_SQL = "SELECT pg_advisory_xact_lock(70128001, 70128002)";
export const PPAN_CAMPAIGN_ACTION_FENCE_SQL = `SELECT 1 FROM ${PPAN_CAMPAIGN_OPERATIONS} WHERE status IN ('PROCESSING','OUTCOME_UNKNOWN') LIMIT 1`;
const PPAN_CAMPAIGN_SCHEMA = `
CREATE TABLE IF NOT EXISTS ${PPAN_CAMPAIGN_OPERATIONS} (
  operation_id uuid PRIMARY KEY,
  owner_id bigint NOT NULL CHECK (owner_id > 0),
  client_id text NOT NULL DEFAULT 'punpan_020' CHECK (client_id = 'punpan_020'),
  campaign_id text NOT NULL CHECK (campaign_id ~ '^[1-9][0-9]{5,30}$'),
  action text NOT NULL CHECK (action IN ('SET_ROI','PAUSE','RESUME')),
  from_status text NOT NULL CHECK (from_status IN ('ENABLE','DISABLE')),
  to_status text NOT NULL CHECK (to_status IN ('ENABLE','DISABLE')),
  from_roi_tenths integer NOT NULL CHECK (from_roi_tenths BETWEEN 1 AND 9999),
  to_roi_tenths integer NOT NULL CHECK (to_roi_tenths BETWEEN 1 AND 9999),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PREPARED' CHECK (status IN ('PREPARED','PROCESSING','NOT_SENT','APPLIED_VERIFIED','OUTCOME_UNKNOWN')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((action='SET_ROI' AND from_status=to_status AND from_roi_tenths<>to_roi_tenths) OR
    (action='PAUSE' AND from_status='ENABLE' AND to_status='DISABLE' AND from_roi_tenths=to_roi_tenths) OR
    (action='RESUME' AND from_status='DISABLE' AND to_status='ENABLE' AND from_roi_tenths=to_roi_tenths))
);
CREATE UNIQUE INDEX IF NOT EXISTS creator_ppan_campaign_one_pending
  ON ${PPAN_CAMPAIGN_OPERATIONS} (client_id) WHERE status IN ('PROCESSING','OUTCOME_UNKNOWN');`;

export type CampaignActionPlan = { operationId: string; ownerId: number; action: CampaignAction; campaignId: string;
  before: CampaignActionTarget; after: CampaignActionTarget; fingerprint: string; expiresAt: string };
export type CampaignActionRecord = CampaignActionPlan & { status: "PREPARED" | "PROCESSING" | CampaignActionOutcome };
type Runner = ReturnType<CreatorWebBudgetDatabase["createQueryRunner"]>;
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("CREATOR_CAMPAIGN_LEDGER_INVALID");
  return Array.isArray(value[0]) && typeof value[1] === "number" ? value[0] : value;
}
function record(value: unknown) {
  const [row, ...rest] = rows(value);
  if (rest.length) throw new Error("CREATOR_CAMPAIGN_LEDGER_INVALID");
  return row ? { operationId: row.operation_id, ownerId: Number(row.owner_id), action: row.action, campaignId: row.campaign_id,
    before: { status: row.from_status, roiTenths: row.from_roi_tenths }, after: { status: row.to_status, roiTenths: row.to_roi_tenths },
    fingerprint: row.fingerprint, expiresAt: new Date(row.expires_at as string | Date).toISOString(), status: row.status } as CampaignActionRecord : null;
}
const budgetFence = `SELECT 1 FROM creator_web_budget_operations WHERE client_id='punpan_020' AND (status='OUTCOME_UNKNOWN' OR
  (status='PROCESSING' AND (mode='live' OR expires_at > clock_timestamp()))) LIMIT 1`;
const continuousFence = `SELECT 1 FROM creator_continuous_auto_budget_sessions WHERE client_id='punpan_020' AND (status<>'STOPPED' OR operation_id IS NOT NULL) LIMIT 1`;
const legacyAutoFence = `SELECT 1 FROM creator_auto_budget_grants WHERE client_id='punpan_020' AND
  ((status='ARMED' AND expires_at > clock_timestamp()) OR (operation_id IS NOT NULL AND settled_at IS NULL)) LIMIT 1`;

export function createPpanCampaignActionStore(db: CreatorWebBudgetDatabase) {
  async function run<T>(work: (runner: Runner) => Promise<T>): Promise<T> {
    const runner = db.createQueryRunner(); let active = false;
    try {
      await runner.connect(); await runner.query("BEGIN"); active = true;
      await runner.query("SET LOCAL lock_timeout = '3s'"); await runner.query("SET LOCAL statement_timeout = '5s'");
      await runner.query("SET LOCAL synchronous_commit = 'on'");
      const result = await work(runner); await runner.query("COMMIT"); active = false; return result;
    } catch {
      if (active) { try { await runner.query("ROLLBACK"); } catch { /* fail closed */ } }
      throw new Error("CREATOR_CAMPAIGN_LEDGER_UNAVAILABLE");
    } finally { try { await runner.release(); } catch { /* hide database details */ } }
  }
  async function blocked(runner: Runner) {
    if (rows(await runner.query(continuousFence)).length || rows(await runner.query(legacyAutoFence)).length) return "AUTO_ACTIVE" as const;
    if (rows(await runner.query(budgetFence)).length || rows(await runner.query(PPAN_CAMPAIGN_ACTION_FENCE_SQL)).length) return "WRITE_LOCKED" as const;
    return null;
  }
  return {
    ensureSchema: () => run(async runner => { await runner.query(PPAN_CAMPAIGN_SCHEMA); }),
    findBlocker: () => run(blocked),
    lastPausedId: () => run(async runner => {
      const [row] = rows(await runner.query(`SELECT campaign_id FROM ${PPAN_CAMPAIGN_OPERATIONS}
        WHERE client_id='punpan_020' AND status='APPLIED_VERIFIED' AND action='PAUSE' ORDER BY updated_at DESC, operation_id DESC LIMIT 1`));
      return typeof row?.campaign_id === "string" ? row.campaign_id : null;
    }),
    create: (p: CampaignActionPlan) => run(async runner => {
      await runner.query(`INSERT INTO ${PPAN_CAMPAIGN_OPERATIONS} (operation_id,owner_id,campaign_id,action,from_status,to_status,from_roi_tenths,to_roi_tenths,fingerprint,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [p.operationId,p.ownerId,p.campaignId,p.action,p.before.status,p.after.status,p.before.roiTenths,p.after.roiTenths,p.fingerprint,p.expiresAt]);
    }),
    get: (ownerId: number, op: string) => run(async runner => record(await runner.query(`SELECT * FROM ${PPAN_CAMPAIGN_OPERATIONS} WHERE owner_id=$1 AND operation_id=$2`, [ownerId,op]))),
    reserve: (ownerId: number, op: string) => run(async runner => {
      await runner.query(PPAN_CAMPAIGN_BUDGET_LOCK_SQL);
      if (await blocked(runner)) return null;
      return record(await runner.query(`UPDATE ${PPAN_CAMPAIGN_OPERATIONS} SET status='PROCESSING',updated_at=clock_timestamp()
        WHERE owner_id=$1 AND operation_id=$2 AND status='PREPARED' AND expires_at>clock_timestamp() RETURNING *`, [ownerId,op]));
    }),
    canDispatch: (ownerId: number, op: string) => run(async runner => {
      if (rows(await runner.query(continuousFence)).length || rows(await runner.query(legacyAutoFence)).length || rows(await runner.query(budgetFence)).length) return false;
      return rows(await runner.query(`SELECT 1 FROM ${PPAN_CAMPAIGN_OPERATIONS} WHERE owner_id=$1 AND operation_id=$2
        AND status='PROCESSING' AND expires_at>clock_timestamp()`, [ownerId,op])).length === 1;
    }),
    finish: (ownerId: number, op: string, outcome: CampaignActionOutcome) => run(async runner => {
      const row = record(await runner.query(`UPDATE ${PPAN_CAMPAIGN_OPERATIONS} SET status=$3,updated_at=clock_timestamp()
        WHERE owner_id=$1 AND operation_id=$2 AND status='PROCESSING' RETURNING *`, [ownerId,op,outcome]));
      if (!row) throw new Error("CREATOR_CAMPAIGN_OPERATION_NOT_PENDING");
      return row;
    }),
  };
}
