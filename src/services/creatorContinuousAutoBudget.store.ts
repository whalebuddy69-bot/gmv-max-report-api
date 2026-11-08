import {
  WEB_BUDGET_CAMPAIGN_ID, WEB_BUDGET_MAX_MINOR, WEB_BUDGET_OPERATION_ID,
} from "./creatorWebBudget.service";
import type { CreatorWebBudgetDatabase } from "./creatorWebBudget.store";

const CLIENT = "punpan_020";
const FINGERPRINT = /^[a-f0-9]{64}$/;
const STOP_REASONS = ["OPERATOR_STOPPED", "CAMPAIGN_ENDED", "LIVE_ENDED", "BASELINE_CHANGED",
  "CAP_CHANGED", "AUTHORITY_REVOKED", "AUTO_DISABLED", "NOT_SENT"] as const;
export type CreatorContinuousAutoBudgetStopReason = (typeof STOP_REASONS)[number];

export interface CreatorContinuousAutoBudgetArmInput {
  sessionId: string;
  ownerId: number;
  campaignId: string;
  liveSessionId: string;
  policyRevision: number;
  baselineBudgetMinor: number;
  baselineFingerprint: string;
  nativeAutoOffAttested: true;
  noConcurrentChangesAttested: true;
}
export interface CreatorContinuousAutoBudgetSession extends CreatorContinuousAutoBudgetArmInput {
  clientId: typeof CLIENT;
  authorizedAt: string;
  status: "ACTIVE" | "BLOCKED" | "STOPPED";
  operationId: string | null;
  lastOutcome: "APPLIED_VERIFIED" | "NOT_SENT" | "OUTCOME_UNKNOWN" | null;
  lastVerifiedAt: string | null;
  stopReason: CreatorContinuousAutoBudgetStopReason | null;
}

export const CREATOR_CONTINUOUS_AUTO_BUDGET_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS creator_continuous_auto_budget_sessions (
  session_id uuid PRIMARY KEY,
  created_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  client_id text NOT NULL CHECK (client_id='punpan_020'),
  owner_id bigint NOT NULL CHECK (owner_id > 0),
  campaign_id text NOT NULL CHECK (campaign_id ~ '^[1-9][0-9]{5,30}$'),
  live_session_id text NOT NULL CHECK (live_session_id ~ '^[1-9][0-9]{5,30}$'),
  policy_revision bigint NOT NULL CHECK (policy_revision > 0),
  baseline_budget_minor bigint NOT NULL CHECK (baseline_budget_minor BETWEEN 1 AND 100000000000),
  baseline_fingerprint text NOT NULL CHECK (baseline_fingerprint ~ '^[a-f0-9]{64}$'),
  authorized_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  native_auto_off_attested boolean NOT NULL CHECK (native_auto_off_attested),
  no_concurrent_changes_attested boolean NOT NULL CHECK (no_concurrent_changes_attested),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED','STOPPED')),
  operation_id uuid UNIQUE,
  last_outcome text CHECK (last_outcome IN ('APPLIED_VERIFIED','NOT_SENT','OUTCOME_UNKNOWN')),
  last_verified_at timestamptz,
  stop_reason text CHECK (stop_reason IN ('OPERATOR_STOPPED','CAMPAIGN_ENDED','LIVE_ENDED','BASELINE_CHANGED',
    'CAP_CHANGED','AUTHORITY_REVOKED','AUTO_DISABLED','NOT_SENT')),
  CHECK ((status='STOPPED') = (stop_reason IS NOT NULL)),
  CHECK (status <> 'BLOCKED' OR (operation_id IS NOT NULL AND last_outcome='OUTCOME_UNKNOWN')),
  CHECK (last_outcome IS DISTINCT FROM 'OUTCOME_UNKNOWN' OR (operation_id IS NOT NULL AND status IN ('BLOCKED','STOPPED')))
);
CREATE UNIQUE INDEX IF NOT EXISTS creator_continuous_auto_budget_one_open_session
  ON creator_continuous_auto_budget_sessions (client_id)
  WHERE status <> 'STOPPED' OR operation_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS creator_continuous_auto_budget_attempts (
  operation_id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES creator_continuous_auto_budget_sessions(session_id),
  client_id text NOT NULL CHECK (client_id='punpan_020'),
  campaign_id text NOT NULL CHECK (campaign_id ~ '^[1-9][0-9]{5,30}$'),
  live_session_id text NOT NULL CHECK (live_session_id ~ '^[1-9][0-9]{5,30}$'),
  baseline_fingerprint text NOT NULL CHECK (baseline_fingerprint ~ '^[a-f0-9]{64}$'),
  baseline_budget_minor bigint NOT NULL CHECK (baseline_budget_minor BETWEEN 1 AND 100000000000),
  target_budget_minor bigint NOT NULL CHECK (target_budget_minor BETWEEN 1 AND 100000000000
    AND target_budget_minor > baseline_budget_minor AND target_budget_minor = (baseline_budget_minor * 6) / 5),
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (client_id,campaign_id,baseline_fingerprint)
);`;

type Runner = ReturnType<CreatorWebBudgetDatabase["createQueryRunner"]>;
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("CREATOR_CONTINUOUS_AUTO_STORE_SHAPE");
  return Array.isArray(value[0]) && typeof value[1] === "number" ? value[0] : value;
}
function identifier(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
function positive(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
}
function integerFromDb(value: unknown): number {
  if (positive(value)) return value;
  if (typeof value === "string" && /^\d{1,16}$/.test(value) && positive(Number(value))) return Number(value);
  throw new Error("CREATOR_CONTINUOUS_AUTO_STORE_SHAPE");
}
function validArm(value: CreatorContinuousAutoBudgetArmInput | null | undefined): value is CreatorContinuousAutoBudgetArmInput {
  return !!value && identifier(value.sessionId, WEB_BUDGET_OPERATION_ID) && positive(value.ownerId) &&
    identifier(value.campaignId, WEB_BUDGET_CAMPAIGN_ID) && identifier(value.liveSessionId, WEB_BUDGET_CAMPAIGN_ID) &&
    positive(value.policyRevision) &&
    positive(value.baselineBudgetMinor, WEB_BUDGET_MAX_MINOR) && identifier(value.baselineFingerprint, FINGERPRINT) &&
    value.nativeAutoOffAttested === true && value.noConcurrentChangesAttested === true;
}
function validAuthorizedAt(value: string): boolean {
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value;
}
function validSession(value: CreatorContinuousAutoBudgetSession): boolean {
  return validArm(value) && value.clientId === CLIENT && validAuthorizedAt(value.authorizedAt);
}
function validTarget(baseline: number, target: number): boolean {
  return positive(target, WEB_BUDGET_MAX_MINOR) && target > baseline && BigInt(target) === BigInt(baseline) * 6n / 5n;
}
function stopReasonValid(value: unknown): value is CreatorContinuousAutoBudgetStopReason {
  return typeof value === "string" && (STOP_REASONS as readonly string[]).includes(value);
}
function timestamp(value: unknown): string {
  if (value instanceof Date || typeof value === "string") return new Date(value).toISOString();
  throw new Error("CREATOR_CONTINUOUS_AUTO_STORE_SHAPE");
}
function map(row: Record<string, unknown>): CreatorContinuousAutoBudgetSession {
  const authorizedAt = timestamp(row.authorized_at);
  const lastVerifiedAt = row.last_verified_at === null ? null : timestamp(row.last_verified_at);
  const { status, last_outcome: lastOutcome, operation_id: operationId, stop_reason: stopReason } = row;
  const value = { clientId: row.client_id, sessionId: row.session_id, ownerId: integerFromDb(row.owner_id),
    campaignId: row.campaign_id, liveSessionId: row.live_session_id, policyRevision: integerFromDb(row.policy_revision),
    baselineBudgetMinor: integerFromDb(row.baseline_budget_minor),
    baselineFingerprint: row.baseline_fingerprint, nativeAutoOffAttested: row.native_auto_off_attested,
    noConcurrentChangesAttested: row.no_concurrent_changes_attested, authorizedAt, status, operationId, lastOutcome, lastVerifiedAt, stopReason };
  if (!validSession(value as CreatorContinuousAutoBudgetSession) ||
    (status !== "ACTIVE" && status !== "BLOCKED" && status !== "STOPPED") ||
    (operationId !== null && !identifier(operationId, WEB_BUDGET_OPERATION_ID)) ||
    (lastOutcome !== null && lastOutcome !== "APPLIED_VERIFIED" && lastOutcome !== "NOT_SENT" && lastOutcome !== "OUTCOME_UNKNOWN") ||
    (status === "STOPPED" ? !stopReasonValid(stopReason) : stopReason !== null) ||
    (lastVerifiedAt !== null && Date.parse(lastVerifiedAt) < Date.parse(authorizedAt)) ||
    (status === "BLOCKED" && (operationId === null || lastOutcome !== "OUTCOME_UNKNOWN")) ||
    (lastOutcome === "OUTCOME_UNKNOWN" && (operationId === null || status === "ACTIVE"))) throw new Error("CREATOR_CONTINUOUS_AUTO_STORE_SHAPE");
  return value as CreatorContinuousAutoBudgetSession;
}
function one(result: unknown) {
  const values = rows(result);
  if (values.length > 1) throw new Error("CREATOR_CONTINUOUS_AUTO_STORE_SHAPE");
  return values.length ? map(values[0]) : null;
}
const SESSION = "creator_continuous_auto_budget_sessions";
const EXACT = `s.client_id='punpan_020' AND s.session_id=$1::uuid AND s.owner_id=$2 AND s.campaign_id=$3
  AND s.policy_revision=$4 AND s.baseline_budget_minor=$5 AND s.baseline_fingerprint=$6
  AND s.authorized_at=$7::timestamptz AND s.live_session_id=$8 AND s.native_auto_off_attested AND s.no_concurrent_changes_attested`;
function args(session: CreatorContinuousAutoBudgetSession) {
  return [session.sessionId, session.ownerId, session.campaignId, session.policyRevision, session.baselineBudgetMinor,
    session.baselineFingerprint, session.authorizedAt, session.liveSessionId];
}
// These are assertions on the existing provider-write ledger, not a second write path.
const EXACT_WEB_OP = `w.client_id='punpan_020' AND w.operation_id=$9::uuid AND w.owner_id=$2 AND w.campaign_id=$3
  AND w.policy_revision=$4 AND w.current_budget_minor=$5 AND w.fingerprint=$6 AND w.mode='live' AND w.source='auto'`;

/**
 * Open-ended, owner-armed authority for one exact Ppan campaign, never a provider writer.
 * Each operation still needs the existing short writer lease, fresh provider evidence,
 * owner revalidation, and provider readback. An unresolved send cannot be reset by Stop.
 */
export function createCreatorContinuousAutoBudgetStore(database: CreatorWebBudgetDatabase) {
  async function run<T>(work: (runner: Runner) => Promise<T>): Promise<T> {
    const runner = database.createQueryRunner();
    let begun = false;
    try {
      await runner.connect();
      await runner.query("BEGIN"); begun = true;
      await runner.query("SET LOCAL lock_timeout = '3s'");
      await runner.query("SET LOCAL statement_timeout = '5s'");
      await runner.query("SET LOCAL synchronous_commit = 'on'");
      const value = await work(runner);
      await runner.query("COMMIT"); begun = false;
      return value;
    } catch {
      if (begun) { try { await runner.query("ROLLBACK"); } catch { /* Ambiguous commit never permits a send. */ } }
      throw new Error("CREATOR_CONTINUOUS_AUTO_STORE_UNAVAILABLE");
    } finally { try { await runner.release(); } catch { /* No driver details in status. */ } }
  }
  return {
    async ensureSchema() { await run(async runner => { await runner.query(CREATOR_CONTINUOUS_AUTO_BUDGET_SCHEMA_SQL); }); },
    async getActive() {
      // Includes stopped sessions whose already reserved operation still needs reconciliation.
      return run(async runner => one(await runner.query(`SELECT * FROM ${SESSION} WHERE client_id='punpan_020'
        AND (status <> 'STOPPED' OR operation_id IS NOT NULL)`)));
    },
    async getLatest() {
      return run(async runner => one(await runner.query(`SELECT * FROM ${SESSION} WHERE client_id='punpan_020'
        ORDER BY created_order DESC LIMIT 1`)));
    },
    async arm(input: CreatorContinuousAutoBudgetArmInput) {
      if (!validArm(input)) return null;
      return run(async runner => one(await runner.query(`INSERT INTO ${SESSION}
        (session_id,client_id,owner_id,campaign_id,policy_revision,baseline_budget_minor,baseline_fingerprint,live_session_id,
         authorized_at,native_auto_off_attested,no_concurrent_changes_attested)
        SELECT $1::uuid,'punpan_020',$2,$3,$4,$5,$6,$7,date_trunc('milliseconds',clock_timestamp()),true,true
        WHERE NOT EXISTS (SELECT 1 FROM creator_continuous_auto_budget_attempts
          WHERE client_id='punpan_020' AND campaign_id=$3 AND baseline_fingerprint=$6)
        ON CONFLICT DO NOTHING RETURNING *`,
      [input.sessionId, input.ownerId, input.campaignId, input.policyRevision, input.baselineBudgetMinor,
        input.baselineFingerprint, input.liveSessionId])));
    },
    async reserve(session: CreatorContinuousAutoBudgetSession, operationId: string, targetBudgetMinor: number) {
      if (!validSession(session) || !identifier(operationId, WEB_BUDGET_OPERATION_ID) || !validTarget(session.baselineBudgetMinor, targetBudgetMinor)) return null;
      return run(async runner => {
        const input = [...args(session), operationId, targetBudgetMinor];
        // The lock makes selection, fingerprint consumption and setting the pending
        // operation atomic across workers. No caller may confirm until this commits.
        const current = rows(await runner.query(`SELECT 1 FROM ${SESSION} s
          WHERE ${EXACT} AND s.status='ACTIVE' AND s.operation_id IS NULL FOR UPDATE`, input.slice(0, 8)));
        if (current.length !== 1) return null;
        const attempt = rows(await runner.query(`INSERT INTO creator_continuous_auto_budget_attempts
          (operation_id,session_id,client_id,campaign_id,live_session_id,baseline_fingerprint,baseline_budget_minor,target_budget_minor)
          SELECT $9::uuid,s.session_id,s.client_id,s.campaign_id,s.live_session_id,s.baseline_fingerprint,s.baseline_budget_minor,$10
          FROM ${SESSION} s
          WHERE ${EXACT} AND EXISTS (SELECT 1 FROM creator_web_budget_operations w WHERE ${EXACT_WEB_OP}
            AND w.target_budget_minor=$10 AND w.status='PREPARED' AND w.expires_at > clock_timestamp())
          ON CONFLICT DO NOTHING RETURNING operation_id`, input));
        if (attempt.length !== 1) return null;
        const reserved = one(await runner.query(`UPDATE ${SESSION} s SET operation_id=$9::uuid,
          last_outcome=NULL,updated_at=clock_timestamp() WHERE ${EXACT} AND s.status='ACTIVE' AND s.operation_id IS NULL
          RETURNING s.*`, input.slice(0, 9)));
        if (!reserved) throw new Error("CREATOR_CONTINUOUS_AUTO_RESERVATION_MISMATCH");
        return reserved;
      });
    },
    async isReserved(session: CreatorContinuousAutoBudgetSession, operationId: string) {
      if (!validSession(session) || !identifier(operationId, WEB_BUDGET_OPERATION_ID)) return false;
      return run(async runner => rows(await runner.query(`SELECT 1 FROM ${SESSION} s
        WHERE ${EXACT} AND s.status='ACTIVE' AND s.operation_id=$9::uuid`, [...args(session), operationId])).length === 1);
    },
    async markUnknown(session: CreatorContinuousAutoBudgetSession, operationId: string) {
      if (!validSession(session) || !identifier(operationId, WEB_BUDGET_OPERATION_ID)) return null;
      return run(async runner => one(await runner.query(`UPDATE ${SESSION} s
        SET status=CASE WHEN s.status='STOPPED' THEN 'STOPPED' ELSE 'BLOCKED' END,
          last_outcome='OUTCOME_UNKNOWN',updated_at=clock_timestamp()
        WHERE ${EXACT} AND s.operation_id=$9::uuid RETURNING s.*`, [...args(session), operationId])));
    },
    async settleVerified(session: CreatorContinuousAutoBudgetSession, operationId: string, next: { budgetMinor: number; fingerprint: string }) {
      if (!validSession(session) || !identifier(operationId, WEB_BUDGET_OPERATION_ID) ||
        !validTarget(session.baselineBudgetMinor, next.budgetMinor) || !identifier(next.fingerprint, FINGERPRINT) ||
        next.fingerprint === session.baselineFingerprint) return null;
      return run(async runner => one(await runner.query(`UPDATE ${SESSION} s
        SET status=CASE WHEN s.status='STOPPED' THEN 'STOPPED' ELSE 'ACTIVE' END, operation_id=NULL,
          baseline_budget_minor=$10,baseline_fingerprint=$11,last_outcome='APPLIED_VERIFIED',
          last_verified_at=date_trunc('milliseconds',clock_timestamp()),updated_at=clock_timestamp()
        WHERE ${EXACT} AND s.operation_id=$9::uuid
          AND NOT EXISTS (SELECT 1 FROM creator_continuous_auto_budget_attempts a WHERE a.client_id=s.client_id
            AND a.campaign_id=s.campaign_id AND a.baseline_fingerprint=$11)
          AND EXISTS (SELECT 1 FROM creator_web_budget_operations w WHERE ${EXACT_WEB_OP}
            AND w.target_budget_minor=$10 AND w.observed_budget_minor=$10
            AND w.observed_fingerprint=$11 AND w.status='APPLIED_VERIFIED')
        RETURNING s.*`, [...args(session), operationId, next.budgetMinor, next.fingerprint])));
    },
    async settleNotSent(session: CreatorContinuousAutoBudgetSession, operationId: string) {
      if (!validSession(session) || !identifier(operationId, WEB_BUDGET_OPERATION_ID)) return null;
      return run(async runner => one(await runner.query(`UPDATE ${SESSION} s SET status='STOPPED',operation_id=NULL,
        last_outcome='NOT_SENT',stop_reason=COALESCE(s.stop_reason,'NOT_SENT'),updated_at=clock_timestamp()
        WHERE ${EXACT} AND s.operation_id=$9::uuid
          AND EXISTS (SELECT 1 FROM creator_web_budget_operations w WHERE ${EXACT_WEB_OP}
            AND (w.status='NOT_SENT' OR (w.status='PREPARED' AND w.expires_at <= clock_timestamp())))
        RETURNING s.*`, [...args(session), operationId])));
    },
    async stop(ownerId: number, sessionId: string, reason: CreatorContinuousAutoBudgetStopReason = "OPERATOR_STOPPED") {
      if (!positive(ownerId) || !identifier(sessionId, WEB_BUDGET_OPERATION_ID) || !stopReasonValid(reason)) return null;
      return run(async runner => one(await runner.query(`UPDATE ${SESSION} s SET status='STOPPED',
        stop_reason=COALESCE(s.stop_reason,$3),updated_at=clock_timestamp()
        WHERE client_id='punpan_020' AND owner_id=$1 AND session_id=$2::uuid RETURNING s.*`, [ownerId, sessionId, reason])));
    },
  };
}
