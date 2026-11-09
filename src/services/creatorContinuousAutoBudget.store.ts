import {
  WEB_BUDGET_CAMPAIGN_ID, WEB_BUDGET_MAX_MINOR, WEB_BUDGET_OPERATION_ID,
} from "./creatorWebBudget.service";
import type { CreatorWebBudgetDatabase } from "./creatorWebBudget.store";
import { allowsScheduledCreatorAuto, isContinuousCreatorBudgetScope, isVerifiedRoomCreator, LIVE_ROOM_SPEND_TREND, supportsContinuousEvidence,
  type ContinuousCreatorBudgetScope, type ContinuousEvidence } from "./creatorBudgetScope";

const CLIENT = "punpan_020";
export type CreatorContinuousAutoBudgetClient = ContinuousCreatorBudgetScope;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const STOP_REASONS = ["OPERATOR_STOPPED", "CAMPAIGN_ENDED", "LIVE_ENDED", "BASELINE_CHANGED",
  "CAP_CHANGED", "AUTHORITY_REVOKED", "AUTO_DISABLED", "NOT_SENT"] as const;
export type CreatorContinuousAutoBudgetStopReason = (typeof STOP_REASONS)[number];
export type CreatorContinuousAutoBudgetEvidenceMode = ContinuousEvidence;

export interface CreatorContinuousAutoBudgetArmInput {
  sessionId: string;
  ownerId: number;
  campaignId: string;
  liveSessionId: string | null;
  evidenceMode?: CreatorContinuousAutoBudgetEvidenceMode;
  policyRevision: number;
  baselineBudgetMinor: number;
  baselineFingerprint: string;
  nativeAutoOffAttested: boolean;
  noConcurrentChangesAttested: boolean;
}
export interface CreatorContinuousAutoBudgetSession extends CreatorContinuousAutoBudgetArmInput {
  clientId: CreatorContinuousAutoBudgetClient;
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

// Upgrade exactly the published v1 constraints. The existing tables, client scope,
// open-session index, historical rows and consumed fingerprints are retained.
export const CREATOR_CONTINUOUS_SPEND_TREND_SCHEMA_SQL = `
DO $creator_continuous_evidence$
DECLARE
  native_checks name[];
  changes_checks name[];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='creator_continuous_auto_budget_sessions'::regclass
      AND conname='creator_continuous_auto_budget_session_evidence_v2' AND convalidated AND contype='c')
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='creator_continuous_auto_budget_attempts'::regclass
      AND conname='creator_continuous_auto_budget_attempt_evidence_v2' AND convalidated AND contype='c') THEN
    RETURN;
  END IF;
  LOCK TABLE creator_continuous_auto_budget_sessions, creator_continuous_auto_budget_attempts IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='creator_continuous_auto_budget_sessions'::regclass
      AND conname='creator_continuous_auto_budget_session_evidence_v2' AND convalidated AND contype='c')
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='creator_continuous_auto_budget_attempts'::regclass
      AND conname='creator_continuous_auto_budget_attempt_evidence_v2' AND convalidated AND contype='c') THEN
    RETURN;
  END IF;
  SELECT array_agg(conname) INTO native_checks FROM pg_constraint
    WHERE conrelid='creator_continuous_auto_budget_sessions'::regclass AND convalidated AND contype='c'
      AND pg_get_expr(conbin,conrelid)='native_auto_off_attested';
  SELECT array_agg(conname) INTO changes_checks FROM pg_constraint
    WHERE conrelid='creator_continuous_auto_budget_sessions'::regclass AND convalidated AND contype='c'
      AND pg_get_expr(conbin,conrelid)='no_concurrent_changes_attested';
  IF cardinality(native_checks) IS DISTINCT FROM 1 OR cardinality(changes_checks) IS DISTINCT FROM 1
    OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid IN ('creator_continuous_auto_budget_sessions'::regclass,
      'creator_continuous_auto_budget_attempts'::regclass) AND attname='evidence_mode' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Unrecognized Creator continuous evidence constraints';
  END IF;
  -- Auto-generated names can be shortened differently across Postgres versions.
  -- Only the two recognized simple boolean expressions above are replaced.
  EXECUTE format('ALTER TABLE creator_continuous_auto_budget_sessions DROP CONSTRAINT %I, DROP CONSTRAINT %I',
    native_checks[1], changes_checks[1]);
  ALTER TABLE creator_continuous_auto_budget_sessions
    ADD COLUMN evidence_mode text NOT NULL DEFAULT 'verified-room',
    ALTER COLUMN live_session_id DROP NOT NULL,
    ADD CONSTRAINT creator_continuous_auto_budget_session_evidence_v2 CHECK (
      (evidence_mode='verified-room' AND live_session_id IS NOT NULL AND native_auto_off_attested AND no_concurrent_changes_attested)
      OR (evidence_mode='spend-trend' AND live_session_id IS NULL AND NOT native_auto_off_attested AND NOT no_concurrent_changes_attested)
    );
  ALTER TABLE creator_continuous_auto_budget_attempts
    ADD COLUMN evidence_mode text NOT NULL DEFAULT 'verified-room',
    ALTER COLUMN live_session_id DROP NOT NULL,
    ADD CONSTRAINT creator_continuous_auto_budget_attempt_evidence_v2 CHECK (
      (evidence_mode='verified-room' AND live_session_id IS NOT NULL)
      OR (evidence_mode='spend-trend' AND live_session_id IS NULL)
    );
END
$creator_continuous_evidence$;`;

// Keep each historical attempt and its writer outcome. Only a durable exact
// NOT_SENT proof may release the fingerprint, and only for spend-trend.
const CREATOR_CONTINUOUS_SAFE_RETRY_SCHEMA_SQL = `
DO $creator_continuous_retry$
DECLARE
  old_keys name[];
  scope_columns smallint[];
  retry_index constant text := 'creator_continuous_auto_attempt_unreleased_v3';
  attempts constant regclass := 'creator_continuous_auto_budget_attempts'::regclass;
BEGIN
  SELECT ARRAY[
      (SELECT attnum FROM pg_attribute WHERE attrelid=attempts AND attname='client_id' AND NOT attisdropped),
      (SELECT attnum FROM pg_attribute WHERE attrelid=attempts AND attname='campaign_id' AND NOT attisdropped),
      (SELECT attnum FROM pg_attribute WHERE attrelid=attempts AND attname='baseline_fingerprint' AND NOT attisdropped)
    ]::smallint[] INTO scope_columns;
  IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    WHERE i.indrelid=attempts AND c.relname=retry_index AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indkey::text=array_to_string(scope_columns,' ')
      AND pg_get_expr(i.indpred,i.indrelid)='(NOT retry_released)') THEN RETURN; END IF;
  LOCK TABLE creator_continuous_auto_budget_sessions, creator_continuous_auto_budget_attempts IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    WHERE i.indrelid=attempts AND c.relname=retry_index AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indkey::text=array_to_string(scope_columns,' ')
      AND pg_get_expr(i.indpred,i.indrelid)='(NOT retry_released)') THEN RETURN; END IF;
  SELECT array_agg(conname) INTO old_keys FROM pg_constraint
    WHERE conrelid=attempts AND convalidated AND contype='u' AND conkey=scope_columns;
  IF cardinality(old_keys) IS DISTINCT FROM 1
    OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=attempts AND attname='retry_released' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Unrecognized Creator continuous retry constraints';
  END IF;
  ALTER TABLE creator_continuous_auto_budget_attempts ADD COLUMN retry_released boolean NOT NULL DEFAULT false
    CONSTRAINT creator_continuous_auto_attempt_retry_scope_v3 CHECK (NOT retry_released OR evidence_mode='spend-trend');
  IF to_regclass('creator_web_budget_operations') IS NOT NULL THEN
    UPDATE creator_continuous_auto_budget_attempts a SET retry_released=true
    FROM creator_continuous_auto_budget_sessions s, creator_web_budget_operations w
    WHERE a.session_id=s.session_id AND a.client_id='punpan_020' AND s.client_id=a.client_id
      AND a.evidence_mode='spend-trend' AND s.evidence_mode=a.evidence_mode AND a.live_session_id IS NULL
      AND s.campaign_id=a.campaign_id AND s.baseline_fingerprint=a.baseline_fingerprint
      AND s.baseline_budget_minor=a.baseline_budget_minor AND s.status='STOPPED'
      AND s.last_outcome='NOT_SENT' AND s.stop_reason='NOT_SENT' AND s.operation_id IS NULL
      AND w.operation_id=a.operation_id AND w.owner_id=s.owner_id AND w.client_id=a.client_id AND w.campaign_id=a.campaign_id
      AND w.policy_revision=s.policy_revision AND w.mode='live' AND w.source='auto' AND w.status='NOT_SENT'
      AND w.current_budget_minor=a.baseline_budget_minor AND w.fingerprint=a.baseline_fingerprint
      AND w.target_budget_minor=a.target_budget_minor AND w.observed_budget_minor IS NULL AND w.observed_fingerprint IS NULL;
  ELSIF EXISTS (SELECT 1 FROM creator_continuous_auto_budget_attempts) THEN
    RAISE EXCEPTION 'Creator continuous retry writer ledger missing';
  END IF;
  CREATE UNIQUE INDEX creator_continuous_auto_attempt_unreleased_v3
    ON creator_continuous_auto_budget_attempts (client_id,campaign_id,baseline_fingerprint) WHERE NOT retry_released;
  EXECUTE format('ALTER TABLE creator_continuous_auto_budget_attempts DROP CONSTRAINT %I',old_keys[1]);
END
$creator_continuous_retry$;`;

const CREATOR_VERIFIED_ROOM_ONLY_SCHEMA_SQL = `
DO $creator_continuous_room_only$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='creator_continuous_auto_budget_sessions'::regclass
    AND conname='creator_continuous_session_room_only' AND convalidated AND contype='c'
    AND pg_get_expr(conbin,conrelid)='(evidence_mode = ''${LIVE_ROOM_SPEND_TREND}''::text)') THEN
    ALTER TABLE creator_continuous_auto_budget_sessions ADD CONSTRAINT creator_continuous_session_room_only CHECK (evidence_mode='${LIVE_ROOM_SPEND_TREND}');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='creator_continuous_auto_budget_attempts'::regclass
    AND conname='creator_continuous_attempt_room_only' AND convalidated AND contype='c'
    AND pg_get_expr(conbin,conrelid)='(evidence_mode = ''${LIVE_ROOM_SPEND_TREND}''::text)') THEN
    ALTER TABLE creator_continuous_auto_budget_attempts ADD CONSTRAINT creator_continuous_attempt_room_only CHECK (evidence_mode='${LIVE_ROOM_SPEND_TREND}');
  END IF;
END
$creator_continuous_room_only$;`;

// Relax only the scheduled scopes' session check. Attempts still require a
// room, and a waiting session cannot hold an operation or provider outcome.
const CREATOR_CONTINUOUS_AWAITING_LIVE_SCHEMA_SQL = `
DO $creator_continuous_awaiting_live$
DECLARE
  sessions constant regclass := 'creator_continuous_auto_budget_sessions'::regclass;
  old_evidence constant text := '(((evidence_mode = ''${LIVE_ROOM_SPEND_TREND}''::text) AND (live_session_id IS NOT NULL) AND native_auto_off_attested AND no_concurrent_changes_attested) OR ((evidence_mode = ''spend-trend''::text) AND (live_session_id IS NULL) AND (NOT native_auto_off_attested) AND (NOT no_concurrent_changes_attested)))';
  new_evidence constant text := '(((evidence_mode = ''${LIVE_ROOM_SPEND_TREND}''::text) AND native_auto_off_attested AND no_concurrent_changes_attested) OR ((evidence_mode = ''spend-trend''::text) AND (live_session_id IS NULL) AND (NOT native_auto_off_attested) AND (NOT no_concurrent_changes_attested)))';
  state_guard constant text := '((evidence_mode <> ''${LIVE_ROOM_SPEND_TREND}''::text) OR (live_session_id IS NOT NULL) OR ((status <> ''BLOCKED''::text) AND (operation_id IS NULL) AND (last_outcome IS NULL) AND (last_verified_at IS NULL)))';
  current_evidence text;
  current_guard text;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO current_evidence FROM pg_constraint WHERE conrelid=sessions
    AND conname='creator_continuous_auto_budget_session_evidence_v2' AND convalidated AND contype='c';
  SELECT pg_get_expr(conbin,conrelid) INTO current_guard FROM pg_constraint WHERE conrelid=sessions
    AND conname='creator_continuous_session_awaiting_live_v4' AND convalidated AND contype='c';
  IF current_evidence=new_evidence AND current_guard=state_guard THEN RETURN; END IF;
  LOCK TABLE creator_continuous_auto_budget_sessions IN ACCESS EXCLUSIVE MODE;
  SELECT pg_get_expr(conbin,conrelid) INTO current_evidence FROM pg_constraint WHERE conrelid=sessions
    AND conname='creator_continuous_auto_budget_session_evidence_v2' AND convalidated AND contype='c';
  SELECT pg_get_expr(conbin,conrelid) INTO current_guard FROM pg_constraint WHERE conrelid=sessions
    AND conname='creator_continuous_session_awaiting_live_v4' AND convalidated AND contype='c';
  IF current_evidence=new_evidence AND current_guard=state_guard THEN RETURN; END IF;
  IF current_evidence IS DISTINCT FROM old_evidence OR current_guard IS NOT NULL THEN
    RAISE EXCEPTION 'Unrecognized Creator scheduled session constraints';
  END IF;
  ALTER TABLE creator_continuous_auto_budget_sessions
    DROP CONSTRAINT creator_continuous_auto_budget_session_evidence_v2,
    ADD CONSTRAINT creator_continuous_auto_budget_session_evidence_v2 CHECK (
      (evidence_mode='${LIVE_ROOM_SPEND_TREND}' AND native_auto_off_attested AND no_concurrent_changes_attested)
      OR (evidence_mode='spend-trend' AND live_session_id IS NULL AND NOT native_auto_off_attested AND NOT no_concurrent_changes_attested)
    ),
    ADD CONSTRAINT creator_continuous_session_awaiting_live_v4 CHECK (
      evidence_mode<>'${LIVE_ROOM_SPEND_TREND}' OR live_session_id IS NOT NULL
      OR (status<>'BLOCKED' AND operation_id IS NULL AND last_outcome IS NULL AND last_verified_at IS NULL)
    );
END
$creator_continuous_awaiting_live$;`;

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
function awaitingLive(value: CreatorContinuousAutoBudgetArmInput): boolean {
  return value.evidenceMode === LIVE_ROOM_SPEND_TREND && value.liveSessionId === null;
}
function validArm(value: CreatorContinuousAutoBudgetArmInput | null | undefined, clientId: CreatorContinuousAutoBudgetClient): value is CreatorContinuousAutoBudgetArmInput {
  return !!value && identifier(value.sessionId, WEB_BUDGET_OPERATION_ID) && positive(value.ownerId) &&
    identifier(value.campaignId, WEB_BUDGET_CAMPAIGN_ID) && positive(value.policyRevision) &&
    positive(value.baselineBudgetMinor, WEB_BUDGET_MAX_MINOR) && identifier(value.baselineFingerprint, FINGERPRINT) &&
    (value.evidenceMode === "spend-trend"
      ? value.liveSessionId === null && value.nativeAutoOffAttested === false && value.noConcurrentChangesAttested === false
      : (value.evidenceMode === undefined || value.evidenceMode === "verified-room" || value.evidenceMode === LIVE_ROOM_SPEND_TREND) &&
        (identifier(value.liveSessionId, WEB_BUDGET_CAMPAIGN_ID) || (allowsScheduledCreatorAuto(clientId) && awaitingLive(value))) &&
        value.nativeAutoOffAttested === true && value.noConcurrentChangesAttested === true);
}
function validAuthorizedAt(value: string): boolean {
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value;
}
function validScopedSession(value: CreatorContinuousAutoBudgetSession, clientId: CreatorContinuousAutoBudgetClient): boolean {
  return validArm(value, clientId) && value.clientId === clientId && supportsContinuousEvidence(clientId, value.evidenceMode ?? "verified-room") &&
    validAuthorizedAt(value.authorizedAt) && (!awaitingLive(value) || (value.status !== "BLOCKED" && value.operationId === null &&
      value.lastOutcome === null && value.lastVerifiedAt === null));
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
function map(row: Record<string, unknown>, clientId: CreatorContinuousAutoBudgetClient): CreatorContinuousAutoBudgetSession {
  const authorizedAt = timestamp(row.authorized_at);
  const lastVerifiedAt = row.last_verified_at === null ? null : timestamp(row.last_verified_at);
  const { status, last_outcome: lastOutcome, operation_id: operationId, stop_reason: stopReason } = row;
  const value = { clientId: row.client_id, sessionId: row.session_id, ownerId: integerFromDb(row.owner_id),
    campaignId: row.campaign_id, liveSessionId: row.live_session_id, evidenceMode: row.evidence_mode, policyRevision: integerFromDb(row.policy_revision),
    baselineBudgetMinor: integerFromDb(row.baseline_budget_minor),
    baselineFingerprint: row.baseline_fingerprint, nativeAutoOffAttested: row.native_auto_off_attested,
    noConcurrentChangesAttested: row.no_concurrent_changes_attested, authorizedAt, status, operationId, lastOutcome, lastVerifiedAt, stopReason };
  if (row.evidence_mode === undefined || !validScopedSession(value as CreatorContinuousAutoBudgetSession, clientId) ||
    (status !== "ACTIVE" && status !== "BLOCKED" && status !== "STOPPED") ||
    (operationId !== null && !identifier(operationId, WEB_BUDGET_OPERATION_ID)) ||
    (lastOutcome !== null && lastOutcome !== "APPLIED_VERIFIED" && lastOutcome !== "NOT_SENT" && lastOutcome !== "OUTCOME_UNKNOWN") ||
    (status === "STOPPED" ? !stopReasonValid(stopReason) : stopReason !== null) ||
    (lastVerifiedAt !== null && Date.parse(lastVerifiedAt) < Date.parse(authorizedAt)) ||
    (status === "BLOCKED" && (operationId === null || lastOutcome !== "OUTCOME_UNKNOWN")) ||
    (lastOutcome === "OUTCOME_UNKNOWN" && (operationId === null || status === "ACTIVE"))) throw new Error("CREATOR_CONTINUOUS_AUTO_STORE_SHAPE");
  return value as CreatorContinuousAutoBudgetSession;
}
function oneScoped(result: unknown, clientId: CreatorContinuousAutoBudgetClient) {
  const values = rows(result);
  if (values.length > 1) throw new Error("CREATOR_CONTINUOUS_AUTO_STORE_SHAPE");
  return values.length ? map(values[0], clientId) : null;
}
const SESSION = "creator_continuous_auto_budget_sessions";
const EXACT_BASE = `s.client_id='punpan_020' AND s.session_id=$1::uuid AND s.owner_id=$2 AND s.campaign_id=$3
  AND s.policy_revision=$4 AND s.baseline_budget_minor=$5 AND s.baseline_fingerprint=$6
  AND s.authorized_at=$7::timestamptz`;
const EXACT = `${EXACT_BASE} AND s.live_session_id IS NOT DISTINCT FROM $8::text
  AND ((s.evidence_mode IN ('verified-room','${LIVE_ROOM_SPEND_TREND}') AND $8::text IS NOT NULL AND s.native_auto_off_attested AND s.no_concurrent_changes_attested)
    OR (s.evidence_mode='spend-trend' AND $8::text IS NULL AND NOT s.native_auto_off_attested AND NOT s.no_concurrent_changes_attested))`;
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
export function createCreatorContinuousAutoBudgetStore(database: CreatorWebBudgetDatabase, clientId: CreatorContinuousAutoBudgetClient = CLIENT) {
  if (!isContinuousCreatorBudgetScope(clientId)) throw new Error("CREATOR_CONTINUOUS_AUTO_SCOPE_UNSUPPORTED");
  // Translate only literal, reviewed scopes. Keep existing tables unchanged
  // and new SQL identifiers short enough to avoid PostgreSQL truncation.
  const prefix = clientId === "srihiw" ? "creator_srihiw_continuous_" : clientId === "ashopbytheta" ? "creator_ashop_cauto_" :
    clientId === "myushop4" ? "creator_myu_cauto_" : "creator_bubpa_cauto_";
  const scopedSql = (sql: string) => clientId === CLIENT ? sql : sql
    .replaceAll("creator_continuous_", prefix)
    .replaceAll("creator_web_budget_operations", `creator_web_budget_${clientId}_operations`)
    .replaceAll("'punpan_020'", `'${clientId}'`);
  const one = (result: unknown) => oneScoped(result, clientId);
  const validSession = (value: CreatorContinuousAutoBudgetSession) => validScopedSession(value, clientId);
  async function run<T>(work: (runner: Pick<Runner, "query">) => Promise<T>): Promise<T> {
    const runner = database.createQueryRunner();
    let begun = false;
    try {
      await runner.connect();
      await runner.query("BEGIN"); begun = true;
      await runner.query("SET LOCAL lock_timeout = '3s'");
      await runner.query("SET LOCAL statement_timeout = '5s'");
      await runner.query("SET LOCAL synchronous_commit = 'on'");
      const value = await work({ query: (sql, parameters) => runner.query(scopedSql(sql), parameters) });
      await runner.query("COMMIT"); begun = false;
      return value;
    } catch {
      if (begun) { try { await runner.query("ROLLBACK"); } catch { /* Ambiguous commit never permits a send. */ } }
      throw new Error("CREATOR_CONTINUOUS_AUTO_STORE_UNAVAILABLE");
    } finally { try { await runner.release(); } catch { /* No driver details in status. */ } }
  }
  return {
    async ensureSchema() { await run(async runner => {
      await runner.query(CREATOR_CONTINUOUS_AUTO_BUDGET_SCHEMA_SQL);
      // These scoped tables are new; old Ppan/Srihiw evidence schema stays byte-for-byte unchanged.
      await runner.query(isVerifiedRoomCreator(clientId) ? CREATOR_CONTINUOUS_SPEND_TREND_SCHEMA_SQL
        .replaceAll("'verified-room'", `'${LIVE_ROOM_SPEND_TREND}'`) : CREATOR_CONTINUOUS_SPEND_TREND_SCHEMA_SQL);
      await runner.query(CREATOR_CONTINUOUS_SAFE_RETRY_SCHEMA_SQL);
      if (isVerifiedRoomCreator(clientId)) await runner.query(CREATOR_VERIFIED_ROOM_ONLY_SCHEMA_SQL);
      if (allowsScheduledCreatorAuto(clientId)) await runner.query(CREATOR_CONTINUOUS_AWAITING_LIVE_SCHEMA_SQL);
    }); },
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
      if (!validArm(input, clientId) || !supportsContinuousEvidence(clientId, input.evidenceMode ?? "verified-room")) return null;
      return run(async runner => one(await runner.query(`INSERT INTO ${SESSION}
        (session_id,client_id,owner_id,campaign_id,policy_revision,baseline_budget_minor,baseline_fingerprint,live_session_id,
         authorized_at,native_auto_off_attested,no_concurrent_changes_attested,evidence_mode)
        SELECT $1::uuid,'punpan_020',$2,$3,$4,$5,$6,$7,date_trunc('milliseconds',clock_timestamp()),$8,$9,$10
        WHERE NOT EXISTS (SELECT 1 FROM creator_continuous_auto_budget_attempts
          WHERE client_id='punpan_020' AND campaign_id=$3 AND baseline_fingerprint=$6 AND (NOT retry_released OR $10<>'spend-trend'))
        ON CONFLICT DO NOTHING RETURNING *`,
      [input.sessionId, input.ownerId, input.campaignId, input.policyRevision, input.baselineBudgetMinor,
        input.baselineFingerprint, input.liveSessionId, input.nativeAutoOffAttested, input.noConcurrentChangesAttested,
        input.evidenceMode ?? "verified-room"])));
    },
    async bindLiveSession(session: CreatorContinuousAutoBudgetSession, liveSessionId: string) {
      if (!allowsScheduledCreatorAuto(clientId) || !validSession(session) || !awaitingLive(session) || session.status !== "ACTIVE" ||
        !identifier(liveSessionId, WEB_BUDGET_CAMPAIGN_ID)) return null;
      // Only a still-open copy of this exact waiting authority can claim a
      // room. This does not change the baseline or reserve any provider write.
      return run(async runner => one(await runner.query(`UPDATE ${SESSION} s
        SET live_session_id=$8,updated_at=clock_timestamp()
        WHERE ${EXACT_BASE} AND s.evidence_mode='${LIVE_ROOM_SPEND_TREND}' AND s.status='ACTIVE'
          AND s.live_session_id IS NULL AND s.operation_id IS NULL AND s.last_outcome IS NULL AND s.last_verified_at IS NULL
          AND s.native_auto_off_attested AND s.no_concurrent_changes_attested
        RETURNING s.*`, [...args(session).slice(0, 7), liveSessionId])));
    },
    async adoptBaseline(session: CreatorContinuousAutoBudgetSession, next: { budgetMinor: number; fingerprint: string; policyRevision: number }) {
      if (!validSession(session) || session.evidenceMode !== "spend-trend" || session.status !== "ACTIVE" ||
        session.operationId !== null || next.policyRevision !== session.policyRevision ||
        !positive(next.budgetMinor, WEB_BUDGET_MAX_MINOR) || !identifier(next.fingerprint, FINGERPRINT) ||
        next.fingerprint === session.baselineFingerprint) return null;
      // This only rebases the current observation. It cannot reserve or send a
      // provider command, clear a fence, consume a fingerprint or fake readback.
      return run(async runner => one(await runner.query(`UPDATE ${SESSION} s
        SET baseline_budget_minor=$9,baseline_fingerprint=$10,updated_at=clock_timestamp()
        WHERE ${EXACT} AND s.evidence_mode='spend-trend' AND s.status='ACTIVE' AND s.operation_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM creator_continuous_auto_budget_attempts a WHERE a.client_id=s.client_id
            AND a.campaign_id=s.campaign_id AND a.baseline_fingerprint=$10 AND NOT a.retry_released)
          AND NOT EXISTS (SELECT 1 FROM creator_web_budget_operations w WHERE w.client_id=s.client_id
            AND (w.status='OUTCOME_UNKNOWN' OR (w.status='PROCESSING' AND (w.mode='live' OR w.expires_at > clock_timestamp()))))
        RETURNING s.*`, [...args(session), next.budgetMinor, next.fingerprint])));
    },
    async reserve(session: CreatorContinuousAutoBudgetSession, operationId: string, targetBudgetMinor: number) {
      if (!validSession(session) || awaitingLive(session) || !identifier(operationId, WEB_BUDGET_OPERATION_ID) || !validTarget(session.baselineBudgetMinor, targetBudgetMinor)) return null;
      return run(async runner => {
        const input = [...args(session), operationId, targetBudgetMinor];
        // The lock makes selection, fingerprint consumption and setting the pending
        // operation atomic across workers. No caller may confirm until this commits.
        const current = rows(await runner.query(`SELECT 1 FROM ${SESSION} s
          WHERE ${EXACT} AND s.status='ACTIVE' AND s.operation_id IS NULL FOR UPDATE`, input.slice(0, 8)));
        if (current.length !== 1) return null;
        const attempt = rows(await runner.query(`INSERT INTO creator_continuous_auto_budget_attempts
          (operation_id,session_id,client_id,campaign_id,live_session_id,baseline_fingerprint,baseline_budget_minor,target_budget_minor,evidence_mode)
          SELECT $9::uuid,s.session_id,s.client_id,s.campaign_id,s.live_session_id,s.baseline_fingerprint,s.baseline_budget_minor,$10,s.evidence_mode
          FROM ${SESSION} s
          WHERE ${EXACT} AND EXISTS (SELECT 1 FROM creator_web_budget_operations w WHERE ${EXACT_WEB_OP}
            AND w.target_budget_minor=$10 AND w.status='PREPARED' AND w.expires_at > clock_timestamp())
          AND (s.evidence_mode='spend-trend' OR NOT EXISTS (
            SELECT 1 FROM creator_continuous_auto_budget_attempts a WHERE a.client_id=s.client_id AND a.campaign_id=s.campaign_id
              AND a.baseline_fingerprint=s.baseline_fingerprint))
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
            AND a.campaign_id=s.campaign_id AND a.baseline_fingerprint=$11 AND (NOT a.retry_released OR s.evidence_mode<>'spend-trend'))
          AND EXISTS (SELECT 1 FROM creator_web_budget_operations w WHERE ${EXACT_WEB_OP}
            AND w.target_budget_minor=$10 AND w.observed_budget_minor=$10
            AND w.observed_fingerprint=$11 AND w.status='APPLIED_VERIFIED')
        RETURNING s.*`, [...args(session), operationId, next.budgetMinor, next.fingerprint])));
    },
    async settleNotSent(session: CreatorContinuousAutoBudgetSession, operationId: string) {
      if (!validSession(session) || !identifier(operationId, WEB_BUDGET_OPERATION_ID)) return null;
      return run(async runner => {
        const input = [...args(session), operationId];
        const pending = one(await runner.query(`SELECT s.* FROM ${SESSION} s
          WHERE ${EXACT} AND s.operation_id=$9::uuid FOR UPDATE`, input));
        if (!pending) return null;
        if (pending.status === "ACTIVE" && pending.evidenceMode === "spend-trend") {
          const released = rows(await runner.query(`UPDATE creator_continuous_auto_budget_attempts a SET retry_released=true
            FROM ${SESSION} s, creator_web_budget_operations w
            WHERE ${EXACT} AND s.operation_id=$9::uuid AND ${EXACT_WEB_OP}
              AND w.status='NOT_SENT' AND w.observed_budget_minor IS NULL AND w.observed_fingerprint IS NULL
              AND a.operation_id=s.operation_id AND a.session_id=s.session_id AND a.client_id=s.client_id
              AND a.campaign_id=s.campaign_id AND a.evidence_mode='spend-trend' AND a.baseline_fingerprint=s.baseline_fingerprint
              AND a.baseline_budget_minor=s.baseline_budget_minor AND a.target_budget_minor=w.target_budget_minor AND NOT a.retry_released
            RETURNING a.operation_id`, input));
          if (released.length === 1) {
            const resumed = one(await runner.query(`UPDATE ${SESSION} s SET operation_id=NULL,last_outcome='NOT_SENT',
              updated_at=clock_timestamp() WHERE ${EXACT} AND s.status='ACTIVE' AND s.operation_id=$9::uuid RETURNING s.*`, input));
            if (!resumed) throw new Error("CREATOR_CONTINUOUS_AUTO_RETRY_MISMATCH");
            return resumed;
          }
        }
        return one(await runner.query(`UPDATE ${SESSION} s SET status='STOPPED',operation_id=NULL,
          last_outcome='NOT_SENT',stop_reason=COALESCE(s.stop_reason,'NOT_SENT'),updated_at=clock_timestamp()
          WHERE ${EXACT} AND s.operation_id=$9::uuid
            AND EXISTS (SELECT 1 FROM creator_web_budget_operations w WHERE ${EXACT_WEB_OP}
              AND (w.status='NOT_SENT' OR (w.status='PREPARED' AND w.expires_at <= clock_timestamp())))
          RETURNING s.*`, input));
      });
    },
    async stop(ownerId: number, sessionId: string, reason: CreatorContinuousAutoBudgetStopReason = "OPERATOR_STOPPED") {
      if (!positive(ownerId) || !identifier(sessionId, WEB_BUDGET_OPERATION_ID) || !stopReasonValid(reason)) return null;
      return run(async runner => one(await runner.query(`UPDATE ${SESSION} s SET status='STOPPED',
        stop_reason=COALESCE(s.stop_reason,$3),updated_at=clock_timestamp()
        WHERE client_id='punpan_020' AND owner_id=$1 AND session_id=$2::uuid RETURNING s.*`, [ownerId, sessionId, reason])));
    },
  };
}
