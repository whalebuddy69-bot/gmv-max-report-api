import { createHash } from "node:crypto";
import type { CreatorWebBudgetDatabase } from "./creatorWebBudget.store";

// Intentionally one reviewed scope. This is quarantine of a historical unknown,
// not a retry, a successful readback, or a general-purpose fence reset.
export const CREATOR_BUDGET_RECOVERY_CLIENT = "bubpa_shop189" as const;
export const CREATOR_BUDGET_RECOVERY_ADVERTISER = "7632368323640115207";
export const CREATOR_BUDGET_RECOVERY_TABLE = "creator_budget_unknown_recoveries";
const WRITER = "creator_web_budget_bubpa_shop189_operations";
const SESSION = "creator_bubpa_cauto_auto_budget_sessions";
const ATTEMPT = "creator_bubpa_cauto_auto_budget_attempts";
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/;
const ID = /^[1-9]\d{5,30}$/;
const HASH = /^[a-f\d]{64}$/;
const MAX = 100_000_000_000;

export interface CreatorBudgetRecoveryRequest {
  recoveryId: string; oldOperationId: string; oldCampaignId: string; newCampaignId: string; acknowledgedUnknown: true;
}
export interface CreatorBudgetRecoveryEvidence {
  clientId: typeof CREATOR_BUDGET_RECOVERY_CLIENT;
  advertiserId: string; identityFingerprint: string; observedAt: string;
  oldCampaignId: string; oldOperationStatus: "DISABLE"; oldListOperationStatus: "DISABLE"; oldBudgetMinor: number;
  newCampaignId: string; newOperationStatus: "ENABLE"; newListOperationStatus: "ENABLE"; soleEnabledCampaignId: string;
  newBudgetMinor: number; newFingerprint: string; newSettingsFingerprint: string; newNonRoiSettingsFingerprint: string;
  newScheduleStartAt: string; newScheduleEndAt: string | null; nativeAutoState: "DISABLED" | "UNKNOWN";
}
export interface CreatorBudgetRecoveryLeaseRequest {
  recoveryId: string; operatorUserId: number; oldOperationId: string; oldCampaignId: string; newCampaignId: string;
  revision: number; acknowledgedUnknown: true;
}
export interface CreatorBudgetRecoveryReceipt {
  schemaVersion: 1; clientId: typeof CREATOR_BUDGET_RECOVERY_CLIENT; recoveryId: string;
  oldOperationId: string; oldCampaignId: string; newCampaignId: string;
  status: "QUARANTINED"; historicalOutcome: "OUTCOME_UNKNOWN"; locked: boolean;
}
export interface CreatorBudgetRecoveryRecord extends CreatorBudgetRecoveryRequest {
  clientId: typeof CREATOR_BUDGET_RECOVERY_CLIENT; operatorUserId: number; revision: number; oldSessionId: string;
  status: "STAGED" | "QUARANTINED"; historicalOutcome: "OUTCOME_UNKNOWN";
  initialEvidence: CreatorBudgetRecoveryEvidence; finalEvidence: CreatorBudgetRecoveryEvidence | null;
  receipt: CreatorBudgetRecoveryReceipt | null; stagedAt: string; quarantinedAt: string | null;
}
type Runner = { query(sql: string, parameters?: unknown[]): Promise<unknown> };
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("CREATOR_BUDGET_RECOVERY_STORE_SHAPE");
  return (Array.isArray(value[0]) ? value[0] : value) as Record<string, unknown>[];
}
const positive = (n: unknown, max = MAX): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= max;
const exactKeys = (value: unknown, keys: readonly string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const iso = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const stamp = (value: unknown) => value instanceof Date ? value.toISOString() : iso(value) ? value : (() => { throw new Error("CREATOR_BUDGET_RECOVERY_STORE_SHAPE"); })();
function jsonObject<T>(value: unknown): T {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("CREATOR_BUDGET_RECOVERY_STORE_SHAPE");
  return parsed as T;
}
export function validCreatorBudgetRecoveryRequest(value: CreatorBudgetRecoveryRequest): boolean {
  // Records contain extra audited fields; validate only the request projection.
  return !!value && UUID.test(value.recoveryId) && UUID.test(value.oldOperationId) && ID.test(value.oldCampaignId) &&
    ID.test(value.newCampaignId) && value.oldCampaignId !== value.newCampaignId && value.acknowledgedUnknown === true;
}
export function validCreatorBudgetRecoveryEvidence(value: CreatorBudgetRecoveryEvidence, request: CreatorBudgetRecoveryRequest, at: Date): boolean {
  if (!exactKeys(value, ["clientId", "advertiserId", "identityFingerprint", "observedAt", "oldCampaignId", "oldOperationStatus", "oldListOperationStatus", "oldBudgetMinor",
    "newCampaignId", "newOperationStatus", "newListOperationStatus", "soleEnabledCampaignId", "newBudgetMinor", "newFingerprint", "newSettingsFingerprint",
    "newNonRoiSettingsFingerprint", "newScheduleStartAt", "newScheduleEndAt", "nativeAutoState"]) || value.clientId !== CREATOR_BUDGET_RECOVERY_CLIENT || value.advertiserId !== CREATOR_BUDGET_RECOVERY_ADVERTISER ||
    !HASH.test(value.identityFingerprint) || !iso(value.observedAt) || !Number.isFinite(at.getTime())) return false;
  const age = at.getTime() - Date.parse(value.observedAt), start = Date.parse(value.newScheduleStartAt);
  const end = value.newScheduleEndAt === null ? Infinity : Date.parse(value.newScheduleEndAt);
  return age >= 0 && age <= 20_000 && value.oldCampaignId === request.oldCampaignId && value.newCampaignId === request.newCampaignId &&
    value.oldOperationStatus === "DISABLE" && value.oldListOperationStatus === "DISABLE" && positive(value.oldBudgetMinor) &&
    value.newOperationStatus === "ENABLE" && value.newListOperationStatus === "ENABLE" && value.soleEnabledCampaignId === request.newCampaignId &&
    positive(value.newBudgetMinor) && HASH.test(value.newFingerprint) && HASH.test(value.newSettingsFingerprint) && HASH.test(value.newNonRoiSettingsFingerprint) &&
    iso(value.newScheduleStartAt) && (value.newScheduleEndAt === null || iso(value.newScheduleEndAt)) && Number.isFinite(start) && end > start && end > at.getTime() &&
    (value.nativeAutoState === "DISABLED" || value.nativeAutoState === "UNKNOWN");
}
export function validCreatorBudgetRecoveryReceipt(value: CreatorBudgetRecoveryReceipt, record: CreatorBudgetRecoveryRecord): boolean {
  return exactKeys(value, ["schemaVersion", "clientId", "recoveryId", "oldOperationId", "oldCampaignId", "newCampaignId", "status", "historicalOutcome", "locked"]) &&
    value.schemaVersion === 1 && value.clientId === record.clientId && value.recoveryId === record.recoveryId &&
    value.oldOperationId === record.oldOperationId && value.oldCampaignId === record.oldCampaignId && value.newCampaignId === record.newCampaignId &&
    value.status === "QUARANTINED" && value.historicalOutcome === "OUTCOME_UNKNOWN" && typeof value.locked === "boolean";
}
function record(row: Record<string, unknown>): CreatorBudgetRecoveryRecord {
  const result: CreatorBudgetRecoveryRecord = {
    recoveryId: String(row.recovery_id), oldOperationId: String(row.old_operation_id), oldCampaignId: String(row.old_campaign_id),
    newCampaignId: String(row.new_campaign_id), acknowledgedUnknown: true, clientId: row.client_id as typeof CREATOR_BUDGET_RECOVERY_CLIENT,
    operatorUserId: Number(row.operator_user_id), revision: Number(row.policy_revision), oldSessionId: String(row.old_session_id),
    status: row.status as CreatorBudgetRecoveryRecord["status"], historicalOutcome: "OUTCOME_UNKNOWN",
    initialEvidence: jsonObject<CreatorBudgetRecoveryEvidence>(row.initial_evidence),
    finalEvidence: row.final_evidence == null ? null : jsonObject<CreatorBudgetRecoveryEvidence>(row.final_evidence),
    receipt: row.control_plane_receipt == null ? null : jsonObject<CreatorBudgetRecoveryReceipt>(row.control_plane_receipt),
    stagedAt: stamp(row.staged_at), quarantinedAt: row.quarantined_at == null ? null : stamp(row.quarantined_at),
  };
  if (!validCreatorBudgetRecoveryRequest(result) || result.clientId !== CREATOR_BUDGET_RECOVERY_CLIENT || !positive(result.operatorUserId, Number.MAX_SAFE_INTEGER) ||
    !positive(result.revision, Number.MAX_SAFE_INTEGER) || !UUID.test(result.oldSessionId) || !["STAGED", "QUARANTINED"].includes(result.status) ||
    (result.status === "QUARANTINED" && (!result.finalEvidence || !result.receipt || !result.quarantinedAt))) throw new Error("CREATOR_BUDGET_RECOVERY_STORE_SHAPE");
  return result;
}
const SCHEMA = `CREATE TABLE IF NOT EXISTS ${CREATOR_BUDGET_RECOVERY_TABLE} (
  recovery_id uuid PRIMARY KEY,client_id text NOT NULL UNIQUE CHECK(client_id='${CREATOR_BUDGET_RECOVERY_CLIENT}'),
  operator_user_id bigint NOT NULL CHECK(operator_user_id>0),old_operation_id uuid NOT NULL UNIQUE,old_session_id uuid NOT NULL UNIQUE,
  old_campaign_id text NOT NULL CHECK(old_campaign_id ~ '^[1-9][0-9]{5,30}$'),new_campaign_id text NOT NULL CHECK(new_campaign_id ~ '^[1-9][0-9]{5,30}$'),
  policy_revision bigint NOT NULL CHECK(policy_revision>0),acknowledged_unknown boolean NOT NULL CHECK(acknowledged_unknown),
  historical_outcome text NOT NULL CHECK(historical_outcome='OUTCOME_UNKNOWN'),status text NOT NULL CHECK(status IN ('STAGED','QUARANTINED')),
  old_writer_snapshot jsonb NOT NULL,old_session_snapshot jsonb NOT NULL,initial_evidence jsonb NOT NULL,initial_evidence_sha256 text NOT NULL CHECK(initial_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  final_evidence jsonb,control_plane_receipt jsonb,staged_at timestamptz NOT NULL DEFAULT clock_timestamp(),quarantined_at timestamptz,
  CHECK(old_campaign_id<>new_campaign_id),
  CHECK((status='STAGED' AND final_evidence IS NULL AND control_plane_receipt IS NULL AND quarantined_at IS NULL) OR
    (status='QUARANTINED' AND final_evidence IS NOT NULL AND control_plane_receipt IS NOT NULL AND quarantined_at IS NOT NULL))
);
CREATE OR REPLACE FUNCTION creator_budget_unknown_recovery_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CREATOR_BUDGET_RECOVERY_IMMUTABLE'; END IF;
  IF OLD.status='QUARANTINED' OR NEW.status<>'QUARANTINED' OR
    (to_jsonb(OLD)-ARRAY['status','final_evidence','control_plane_receipt','quarantined_at']) IS DISTINCT FROM
    (to_jsonb(NEW)-ARRAY['status','final_evidence','control_plane_receipt','quarantined_at']) THEN
    RAISE EXCEPTION 'CREATOR_BUDGET_RECOVERY_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='${CREATOR_BUDGET_RECOVERY_TABLE}'::regclass AND tgname='creator_budget_unknown_recovery_immutable') THEN
    CREATE TRIGGER creator_budget_unknown_recovery_immutable BEFORE UPDATE OR DELETE ON ${CREATOR_BUDGET_RECOVERY_TABLE}
      FOR EACH ROW EXECUTE FUNCTION creator_budget_unknown_recovery_immutable();
  END IF;
END $$;`;
const normalize = (value: unknown) => String(value).replace(/::text/g, "").replace(/\s|\(|\)/g, "");
async function upgradeIndex(runner: Runner, table: string, name: string, oldPredicate: string) {
  const indexes = rows(await runner.query(`SELECT i.indisunique,i.indisvalid,i.indisready,i.indnkeyatts,i.indnatts,t.relname AS table_name,a.amname,
    ARRAY(SELECT att.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num,ord)
      LEFT JOIN pg_attribute att ON att.attrelid=i.indrelid AND att.attnum=k.num ORDER BY k.ord) AS columns,
    pg_get_expr(i.indpred,i.indrelid) AS predicate
    FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
      JOIN pg_am a ON a.oid=x.relam WHERE x.oid=to_regclass($1)`, [name]));
  const found = indexes[0], newer = `(${oldPredicate}) AND quarantined_by_recovery_id IS NULL`;
  if (indexes.length !== 1 || !found.indisunique || !found.indisvalid || !found.indisready || Number(found.indnkeyatts) !== 1 || Number(found.indnatts) !== 1 ||
    found.table_name !== table || found.amname !== "btree" || !Array.isArray(found.columns) || found.columns.join(",") !== "client_id" ||
    ![normalize(oldPredicate), normalize(newer)].includes(normalize(found.predicate))) throw new Error("CREATOR_BUDGET_RECOVERY_INDEX_UNEXPECTED");
  if (normalize(found.predicate) === normalize(newer)) return;
  await runner.query(`DROP INDEX ${name}`);
  await runner.query(`CREATE UNIQUE INDEX ${name} ON ${table}(client_id) WHERE ${newer}`);
}
export async function ensureCreatorBudgetRecoveryWriterSchema(runner: Runner) {
  await runner.query(SCHEMA);
  await runner.query(`LOCK TABLE ${WRITER} IN SHARE ROW EXCLUSIVE MODE`);
  await runner.query(`ALTER TABLE ${WRITER} ADD COLUMN IF NOT EXISTS quarantined_by_recovery_id uuid REFERENCES ${CREATOR_BUDGET_RECOVERY_TABLE}(recovery_id)
    CHECK(quarantined_by_recovery_id IS NULL OR (status='OUTCOME_UNKNOWN' AND observed_budget_minor IS NULL AND observed_fingerprint IS NULL))`);
  await upgradeIndex(runner, WRITER, "creator_web_budget_bubpa_shop189_one_active_fence", "status = ANY (ARRAY['PROCESSING'::text, 'OUTCOME_UNKNOWN'::text])");
}
export async function ensureCreatorBudgetRecoverySessionSchema(runner: Runner) {
  await runner.query(SCHEMA);
  await runner.query(`LOCK TABLE ${SESSION} IN SHARE ROW EXCLUSIVE MODE`);
  await runner.query(`ALTER TABLE ${SESSION} ADD COLUMN IF NOT EXISTS quarantined_by_recovery_id uuid REFERENCES ${CREATOR_BUDGET_RECOVERY_TABLE}(recovery_id)
    CHECK(quarantined_by_recovery_id IS NULL OR (status='STOPPED' AND last_outcome='OUTCOME_UNKNOWN' AND operation_id IS NOT NULL))`);
  await upgradeIndex(runner, SESSION, "creator_bubpa_cauto_auto_budget_one_open_session", "status <> 'STOPPED'::text OR operation_id IS NOT NULL");
}
// SQL arguments below are code-owned column/placeholder expressions, never request data.
export function creatorBudgetRecoveryCandidateAllowedSql(campaign: string): string {
  return `(NOT EXISTS(SELECT 1 FROM ${CREATOR_BUDGET_RECOVERY_TABLE} r WHERE r.client_id='${CREATOR_BUDGET_RECOVERY_CLIENT}') OR
    EXISTS(SELECT 1 FROM ${CREATOR_BUDGET_RECOVERY_TABLE} r WHERE r.client_id='${CREATOR_BUDGET_RECOVERY_CLIENT}' AND r.status='QUARANTINED' AND r.new_campaign_id=${campaign}))`;
}
export function creatorBudgetRecoveryQuarantinedWriterSql(alias: string, campaign: string): string {
  return `EXISTS(SELECT 1 FROM ${CREATOR_BUDGET_RECOVERY_TABLE} r WHERE r.recovery_id=${alias}.quarantined_by_recovery_id
    AND r.client_id=${alias}.client_id AND r.status='QUARANTINED' AND r.old_operation_id=${alias}.operation_id
    AND r.old_campaign_id=${alias}.campaign_id AND ${alias}.status='OUTCOME_UNKNOWN' AND r.new_campaign_id=${campaign})`;
}
export function creatorBudgetRecoveryQuarantinedSessionSql(alias: string): string {
  return `(${alias}.status='STOPPED' AND ${alias}.last_outcome='OUTCOME_UNKNOWN' AND EXISTS(SELECT 1 FROM ${CREATOR_BUDGET_RECOVERY_TABLE} r
    WHERE r.recovery_id=${alias}.quarantined_by_recovery_id AND r.client_id=${alias}.client_id AND r.status='QUARANTINED'
      AND r.old_session_id=${alias}.session_id AND r.old_operation_id=${alias}.operation_id AND r.old_campaign_id=${alias}.campaign_id))`;
}
function sameRequest(row: CreatorBudgetRecoveryRecord, actor: number, input: CreatorBudgetRecoveryRequest) {
  return row.recoveryId === input.recoveryId && row.operatorUserId === actor && row.oldOperationId === input.oldOperationId &&
    row.oldCampaignId === input.oldCampaignId && row.newCampaignId === input.newCampaignId;
}

export function createCreatorBudgetRecoveryStore(database: CreatorWebBudgetDatabase, now = () => new Date()) {
  async function run<T>(work: (runner: Runner) => Promise<T>): Promise<T> {
    const runner = database.createQueryRunner(); let begun = false;
    try {
      await runner.connect(); await runner.query("BEGIN"); begun = true;
      await runner.query("SET LOCAL lock_timeout='3s'"); await runner.query("SET LOCAL statement_timeout='5s'"); await runner.query("SET LOCAL synchronous_commit='on'");
      const result = await work(runner); await runner.query("COMMIT"); begun = false; return result;
    } catch (error) { if (begun) { try { await runner.query("ROLLBACK"); } catch { /* Keep both fences on ambiguous commit. */ } } throw error;
    } finally { try { await runner.release(); } catch { /* No connection metadata. */ } }
  }
  async function getIn(runner: Runner, recoveryId: string, lock = false) {
    const found = rows(await runner.query(`SELECT * FROM ${CREATOR_BUDGET_RECOVERY_TABLE} WHERE recovery_id=$1 ${lock ? "FOR UPDATE" : ""}`, [recoveryId]));
    return found.length === 1 ? record(found[0]) : null;
  }
  async function lockedHistory(runner: Runner, input: CreatorBudgetRecoveryRequest) {
    // A common table lock order also excludes a simultaneous legacy writer/session mutation.
    await runner.query(`LOCK TABLE ${WRITER},${SESSION},${ATTEMPT} IN SHARE ROW EXCLUSIVE MODE`);
    const writers = rows(await runner.query(`SELECT * FROM ${WRITER} WHERE client_id=$1 AND status IN ('PROCESSING','OUTCOME_UNKNOWN')
      AND quarantined_by_recovery_id IS NULL FOR UPDATE`, [CREATOR_BUDGET_RECOVERY_CLIENT]));
    const old = writers[0];
    if (writers.length !== 1 || old.operation_id !== input.oldOperationId || old.campaign_id !== input.oldCampaignId || old.status !== "OUTCOME_UNKNOWN" ||
      old.mode !== "live" || old.source !== "auto" || old.observed_budget_minor !== null || old.observed_fingerprint !== null || old.reserved_at == null) throw new Error("CREATOR_BUDGET_RECOVERY_WRITER_MISMATCH");
    const sessions = rows(await runner.query(`SELECT * FROM ${SESSION} WHERE client_id=$1 AND (status<>'STOPPED' OR operation_id IS NOT NULL)
      AND quarantined_by_recovery_id IS NULL FOR UPDATE`, [CREATOR_BUDGET_RECOVERY_CLIENT]));
    const stopped = sessions[0];
    if (sessions.length !== 1 || stopped.operation_id !== input.oldOperationId || stopped.campaign_id !== input.oldCampaignId || stopped.status !== "STOPPED" ||
      stopped.last_outcome !== "OUTCOME_UNKNOWN" || stopped.owner_id !== old.owner_id || stopped.baseline_fingerprint !== old.fingerprint ||
      String(stopped.baseline_budget_minor) !== String(old.current_budget_minor) || String(stopped.policy_revision) !== String(old.policy_revision)) throw new Error("CREATOR_BUDGET_RECOVERY_SESSION_MISMATCH");
    const attempts = rows(await runner.query(`SELECT * FROM ${ATTEMPT} WHERE client_id=$1 AND operation_id=$2 AND session_id=$3 AND campaign_id=$4
      AND baseline_fingerprint=$5 AND target_budget_minor=$6 AND NOT retry_released`,
    [CREATOR_BUDGET_RECOVERY_CLIENT, input.oldOperationId, stopped.session_id, input.oldCampaignId, old.fingerprint, old.target_budget_minor]));
    if (attempts.length !== 1) throw new Error("CREATOR_BUDGET_RECOVERY_ATTEMPT_MISMATCH");
    if (rows(await runner.query(`SELECT 1 FROM ${WRITER} WHERE client_id=$1 AND status='PREPARED' AND expires_at>clock_timestamp() LIMIT 1`,
      [CREATOR_BUDGET_RECOVERY_CLIENT])).length) throw new Error("CREATOR_BUDGET_RECOVERY_COMPETING_PROPOSAL");
    return { old, stopped };
  }
  return {
    async ensureSchema() { await run(async runner => { await ensureCreatorBudgetRecoveryWriterSchema(runner); await ensureCreatorBudgetRecoverySessionSchema(runner); }); },
    async get(recoveryId: string) { if (!UUID.test(recoveryId)) return null; return run(runner => getIn(runner, recoveryId)); },
    async stage(operatorUserId: number, input: CreatorBudgetRecoveryRequest, evidence: CreatorBudgetRecoveryEvidence) {
      if (!positive(operatorUserId, Number.MAX_SAFE_INTEGER) || !validCreatorBudgetRecoveryRequest(input) || !validCreatorBudgetRecoveryEvidence(evidence, input, now())) throw new Error("CREATOR_BUDGET_RECOVERY_EVIDENCE_UNVERIFIED");
      return run(async runner => {
        const existing = await getIn(runner, input.recoveryId);
        if (existing) { if (!sameRequest(existing, operatorUserId, input)) throw new Error("CREATOR_BUDGET_RECOVERY_ID_CONFLICT"); return existing; }
        const { old, stopped } = await lockedHistory(runner, input);
        if (String(old.owner_id) !== String(operatorUserId)) throw new Error("CREATOR_BUDGET_RECOVERY_OWNER_MISMATCH");
        const concurrent = await getIn(runner, input.recoveryId);
        if (concurrent) { if (!sameRequest(concurrent, operatorUserId, input)) throw new Error("CREATOR_BUDGET_RECOVERY_ID_CONFLICT"); return concurrent; }
        if (!validCreatorBudgetRecoveryEvidence(evidence, input, now())) throw new Error("CREATOR_BUDGET_RECOVERY_EVIDENCE_UNVERIFIED");
        const inserted = rows(await runner.query(`INSERT INTO ${CREATOR_BUDGET_RECOVERY_TABLE}
          (recovery_id,client_id,operator_user_id,old_operation_id,old_session_id,old_campaign_id,new_campaign_id,policy_revision,acknowledged_unknown,
           historical_outcome,status,old_writer_snapshot,old_session_snapshot,initial_evidence,initial_evidence_sha256)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,'OUTCOME_UNKNOWN','STAGED',$9::jsonb,$10::jsonb,$11::jsonb,$12) RETURNING *`,
        [input.recoveryId, CREATOR_BUDGET_RECOVERY_CLIENT, operatorUserId, input.oldOperationId, stopped.session_id, input.oldCampaignId, input.newCampaignId,
          old.policy_revision, JSON.stringify(old), JSON.stringify(stopped), JSON.stringify(evidence), createHash("sha256").update(JSON.stringify(evidence)).digest("hex")]));
        if (inserted.length !== 1) throw new Error("CREATOR_BUDGET_RECOVERY_STAGE_FAILED"); return record(inserted[0]);
      });
    },
    async finalize(recoveryId: string, receipt: CreatorBudgetRecoveryReceipt, evidence: CreatorBudgetRecoveryEvidence) {
      if (!UUID.test(recoveryId)) throw new Error("CREATOR_BUDGET_RECOVERY_INPUT_INVALID");
      return run(async runner => {
        const audit = await getIn(runner, recoveryId, true);
        if (!audit || !validCreatorBudgetRecoveryReceipt(receipt, audit)) throw new Error("CREATOR_BUDGET_RECOVERY_RECEIPT_UNVERIFIED");
        if (audit.status === "QUARANTINED") return audit;
        if (receipt.locked || !validCreatorBudgetRecoveryEvidence(evidence, audit, now()) ||
          evidence.identityFingerprint !== audit.initialEvidence.identityFingerprint) throw new Error("CREATOR_BUDGET_RECOVERY_EVIDENCE_UNVERIFIED");
        const { old, stopped } = await lockedHistory(runner, audit);
        if (String(old.policy_revision) !== String(audit.revision) || stopped.session_id !== audit.oldSessionId) throw new Error("CREATOR_BUDGET_RECOVERY_HISTORY_CHANGED");
        const snapshots = rows(await runner.query(`SELECT old_writer_snapshot,old_session_snapshot FROM ${CREATOR_BUDGET_RECOVERY_TABLE} WHERE recovery_id=$1`, [recoveryId]))[0];
        const stableHistory = (value: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(value)
          .filter(([key]) => key !== "updated_at" && key !== "quarantined_by_recovery_id").sort(([a], [b]) => a.localeCompare(b))));
        if (!snapshots || stableHistory(old) !== stableHistory(jsonObject<Record<string, unknown>>(snapshots.old_writer_snapshot)) ||
          stableHistory(stopped) !== stableHistory(jsonObject<Record<string, unknown>>(snapshots.old_session_snapshot)) ||
          !validCreatorBudgetRecoveryEvidence(evidence, audit, now())) throw new Error("CREATOR_BUDGET_RECOVERY_HISTORY_CHANGED");
        const updated = rows(await runner.query(`UPDATE ${CREATOR_BUDGET_RECOVERY_TABLE} SET status='QUARANTINED',final_evidence=$2::jsonb,
          control_plane_receipt=$3::jsonb,quarantined_at=clock_timestamp() WHERE recovery_id=$1 AND status='STAGED' RETURNING *`,
        [recoveryId, JSON.stringify(evidence), JSON.stringify(receipt)]));
        if (updated.length !== 1) throw new Error("CREATOR_BUDGET_RECOVERY_FINALIZE_CONFLICT");
        const writer = rows(await runner.query(`UPDATE ${WRITER} SET quarantined_by_recovery_id=$1 WHERE operation_id=$2 AND client_id=$3
          AND campaign_id=$4 AND status='OUTCOME_UNKNOWN' AND quarantined_by_recovery_id IS NULL RETURNING operation_id`,
        [recoveryId, audit.oldOperationId, audit.clientId, audit.oldCampaignId]));
        const session = rows(await runner.query(`UPDATE ${SESSION} SET quarantined_by_recovery_id=$1 WHERE session_id=$2 AND client_id=$3
          AND operation_id=$4 AND campaign_id=$5 AND status='STOPPED' AND last_outcome='OUTCOME_UNKNOWN' AND quarantined_by_recovery_id IS NULL RETURNING session_id`,
        [recoveryId, audit.oldSessionId, audit.clientId, audit.oldOperationId, audit.oldCampaignId]));
        if (writer.length !== 1 || session.length !== 1) throw new Error("CREATOR_BUDGET_RECOVERY_ANNOTATION_FAILED"); return record(updated[0]);
      });
    },
  };
}
