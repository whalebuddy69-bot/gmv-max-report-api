import type { CreatorWebBudgetDatabase } from "./creatorWebBudget.store";
import { WEB_BUDGET_MAX_MINOR, WEB_BUDGET_OPERATION_ID } from "./creatorWebBudget.service";

export const PPAN_AUTO_TICK_REASONS = [
  "NOT_ARMED", "SESSION_STOPPED", "AUTO_DISABLED", "AUTHORITY_REVOKED", "LEGACY_BUSY", "CAMPAIGN_ENDED", "LIVE_ENDED",
  "CAP_CHANGED", "BASELINE_CHANGED", "BASELINE_ADOPTED", "CONTEXT_UNAVAILABLE", "NATIVE_AUTO_CONFLICT", "NATIVE_AUTO_UNVERIFIED",
  "LIVE_DELIVERY_UNVERIFIED", "SPEND_WATERMARK_MISSING", "SPEND_UPDATE_PENDING", "LINE_NOT_READY", "WRITE_LOCKED",
  "BELOW_THRESHOLD", "SPEND_TREND_PENDING", "CAP_REACHED", "TARGET_UNAVAILABLE", "PENDING", "NOT_SENT", "OUTCOME_UNKNOWN",
  "APPLIED_VERIFIED", "ERROR",
] as const;
export type PpanAutoTickReason = typeof PPAN_AUTO_TICK_REASONS[number];
export interface PpanAutoTickObservation {
  checkedAt: string;
  reason: PpanAutoTickReason;
  sessionId?: string | null;
  lastValidReadAt?: string | null;
}
const HISTORY_OUTCOMES = ["APPLIED_VERIFIED", "NOT_SENT", "OUTCOME_UNKNOWN", "PROVIDER_REJECTED"] as const;
const HISTORY_REASONS = new Set([
  "EXACT_PROVIDER_READBACK", "NOT_SENT", "PROVIDER_REJECTED", "PREFLIGHT_BLOCKED", "READBACK_UNVERIFIED", "DISPATCH_RESULT_UNAVAILABLE",
  "BUDGET_AUTO_PREFLIGHT", "BUDGET_PRECONDITION_CHANGED", "BUDGET_AUTHORITY_CHANGED", "BUDGET_LEASE_UNVERIFIED", "BUDGET_CONTEXT_UNVERIFIED",
  "BUDGET_NATIVE_AUTO_CONFLICT", "BUDGET_BASELINE_CHANGED", "BUDGET_POLICY_LOCKED", "BUDGET_CAP_UNAVAILABLE", "BUDGET_CAP_EXCEEDED",
  "BUDGET_BELOW_SPEND", "PPAN_TREND_PREFLIGHT_SIGNAL", "PPAN_TREND_PREFLIGHT_BASELINE", "PPAN_TREND_PREFLIGHT_POLICY",
  "PPAN_TREND_PREFLIGHT_AUTHORITY", "PPAN_TREND_PREFLIGHT_NATIVE_OR_LINE",
]);
export interface PpanAutoHistoryItem {
  operationId: string;
  checkedAt: string;
  status: typeof HISTORY_OUTCOMES[number];
  previousBudgetMinor: number;
  targetBudgetMinor: number;
  observedBudgetMinor: number | null;
  reason: string;
}
export interface PpanAutoObservabilityStatus {
  lastTickAt: string | null;
  lastValidReadAt: string | null;
  reason: PpanAutoTickReason | null;
  heartbeatStale: boolean;
  history: PpanAutoHistoryItem[];
}

const ALERT_KINDS = ["OUTCOME_UNKNOWN", "HEARTBEAT_STALE", "CHECKS_FAILING"] as const;
export interface PpanAutoAlertCandidate {
  sessionId: string;
  kind: typeof ALERT_KINDS[number];
  incidentKey: string;
}
export interface PpanAutoWatchState {
  armState: "ACTIVE" | "INACTIVE";
  sessionId: string | null;
  incident: PpanAutoAlertCandidate | null;
}

const SCOPE = "punpan_020";
const ERROR_REASONS_SQL = "'CONTEXT_UNAVAILABLE','LINE_NOT_READY','ERROR'";
const HEALTH_TABLE = "creator_ppan_auto_observability";
const ALERT_TABLE = "creator_ppan_auto_health_alerts";
const EPOCH_TABLE = "creator_ppan_auto_observability_epoch";
const SCHEMA = `
CREATE TABLE IF NOT EXISTS ${EPOCH_TABLE} (
  client_id text PRIMARY KEY CHECK (client_id='${SCOPE}'),
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO ${EPOCH_TABLE}(client_id) VALUES ('${SCOPE}') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ${HEALTH_TABLE} (
  client_id text PRIMARY KEY CHECK (client_id='${SCOPE}'),
  session_id uuid,
  checked_at timestamptz NOT NULL,
  last_valid_read_at timestamptz CHECK (last_valid_read_at IS NULL OR last_valid_read_at<=checked_at),
  reason text NOT NULL CHECK (reason IN (${PPAN_AUTO_TICK_REASONS.map(reason => `'${reason}'`).join(",")})),
  failing_since timestamptz CHECK (failing_since IS NULL OR failing_since<=checked_at)
);
CREATE TABLE IF NOT EXISTS ${ALERT_TABLE} (
  client_id text NOT NULL CHECK (client_id='${SCOPE}'),
  session_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('OUTCOME_UNKNOWN','HEARTBEAT_STALE','CHECKS_FAILING')),
  incident_key text NOT NULL CHECK (length(incident_key) BETWEEN 1 AND 40),
  retry_key uuid NOT NULL UNIQUE,
  accepted_at timestamptz,
  PRIMARY KEY (client_id,session_id,kind,incident_key)
);`;

const WRITE_TICK = `
INSERT INTO ${HEALTH_TABLE} AS current (client_id,session_id,checked_at,last_valid_read_at,reason,failing_since)
SELECT '${SCOPE}',$1::uuid,$2::timestamptz,$3::timestamptz,$4::text,
  CASE WHEN $4::text IN (${ERROR_REASONS_SQL}) THEN $2::timestamptz ELSE NULL END
WHERE $1::uuid IS NOT DISTINCT FROM (SELECT session_id FROM creator_continuous_auto_budget_sessions
  WHERE client_id='${SCOPE}' ORDER BY created_order DESC LIMIT 1)
  AND ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM creator_continuous_auto_budget_sessions
    WHERE client_id='${SCOPE}' AND session_id=$1::uuid AND authorized_at<=$2::timestamptz
      AND ($3::timestamptz IS NULL OR authorized_at<=$3::timestamptz)))
ON CONFLICT (client_id) DO UPDATE SET session_id=EXCLUDED.session_id, checked_at=EXCLUDED.checked_at,
  last_valid_read_at=CASE WHEN current.session_id IS NOT DISTINCT FROM EXCLUDED.session_id
    THEN GREATEST(current.last_valid_read_at,EXCLUDED.last_valid_read_at) ELSE EXCLUDED.last_valid_read_at END,
  reason=EXCLUDED.reason,
  failing_since=CASE WHEN EXCLUDED.failing_since IS NOT NULL AND current.session_id IS NOT DISTINCT FROM EXCLUDED.session_id
    THEN COALESCE(current.failing_since,EXCLUDED.failing_since) ELSE EXCLUDED.failing_since END
WHERE current.checked_at<EXCLUDED.checked_at`;

// Scope and owner are matched through both independent ledgers. No stored raw TikTok or LINE payload is selected.
const READ_HISTORY = `SELECT a.operation_id,w.updated_at,w.status,w.current_budget_minor,w.target_budget_minor,w.observed_budget_minor,w.reason
FROM creator_continuous_auto_budget_attempts a
JOIN creator_continuous_auto_budget_sessions s ON s.session_id=a.session_id AND s.client_id=a.client_id AND s.campaign_id=a.campaign_id
JOIN creator_web_budget_operations w ON w.operation_id=a.operation_id AND w.client_id=a.client_id AND w.campaign_id=a.campaign_id
  AND w.owner_id=s.owner_id AND w.policy_revision=s.policy_revision AND w.current_budget_minor=a.baseline_budget_minor
  AND w.target_budget_minor=a.target_budget_minor AND w.fingerprint=a.baseline_fingerprint
WHERE a.client_id='${SCOPE}' AND s.owner_id=$1 AND w.source='auto' AND w.mode='live'
  AND w.status IN ('APPLIED_VERIFIED','NOT_SENT','OUTCOME_UNKNOWN','PROVIDER_REJECTED')
  AND (w.status<>'APPLIED_VERIFIED' OR (w.observed_budget_minor=w.target_budget_minor AND w.observed_fingerprint IS NOT NULL))
ORDER BY w.updated_at DESC,a.operation_id LIMIT 6`;

const READ_HEALTH = `WITH session AS (SELECT session_id,authorized_at,status FROM creator_continuous_auto_budget_sessions
  WHERE client_id='${SCOPE}' AND owner_id=$1 ORDER BY created_order DESC LIMIT 1)
SELECT h.checked_at,h.last_valid_read_at,h.reason,
  s.status IN ('ACTIVE','BLOCKED') AND COALESCE(h.checked_at,GREATEST(s.authorized_at,e.installed_at))<=clock_timestamp()-interval '3 minutes' AS heartbeat_stale
FROM session s LEFT JOIN ${HEALTH_TABLE} h ON h.client_id='${SCOPE}' AND h.session_id=s.session_id
LEFT JOIN ${EPOCH_TABLE} e ON e.client_id='${SCOPE}'`;

// An independent monitor can read the same stable incident and reuse its single persisted retry key.
// Do not use this service's in-process timer to claim availability monitoring when the process is down.
const ALERT_CANDIDATE = `WITH latest AS (
  SELECT session_id,authorized_at,status,operation_id,last_outcome,keep_auto_across_rooms FROM creator_continuous_auto_budget_sessions
  WHERE client_id='${SCOPE}' ORDER BY created_order DESC LIMIT 1
), findings AS (
  SELECT s.session_id,f.kind,f.incident_key,f.priority,s.keep_auto_across_rooms,h.reason AS health_reason
  FROM latest s LEFT JOIN ${HEALTH_TABLE} h ON h.client_id='${SCOPE}' AND h.session_id=s.session_id
  LEFT JOIN ${EPOCH_TABLE} e ON e.client_id='${SCOPE}'
  CROSS JOIN LATERAL (VALUES
    ('OUTCOME_UNKNOWN', CASE WHEN s.last_outcome='OUTCOME_UNKNOWN' THEN s.operation_id::text END, 1),
    ('HEARTBEAT_STALE', CASE WHEN s.status IN ('ACTIVE','BLOCKED') AND COALESCE(h.checked_at,GREATEST(s.authorized_at,e.installed_at))<=clock_timestamp()-interval '3 minutes'
      THEN floor(extract(epoch FROM COALESCE(h.checked_at,GREATEST(s.authorized_at,e.installed_at)))*1000)::bigint::text END, 2),
    ('CHECKS_FAILING', CASE WHEN s.status='ACTIVE' AND h.failing_since<=clock_timestamp()-interval '3 minutes'
      THEN floor(extract(epoch FROM h.failing_since)*1000)::bigint::text END, 3)
  ) f(kind,incident_key,priority)
  WHERE f.incident_key IS NOT NULL
)`;

type Runner = ReturnType<CreatorWebBudgetDatabase["createQueryRunner"]>;
function asRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("PPAN_AUTO_OBSERVABILITY_SHAPE");
  return Array.isArray(value[0]) && typeof value[1] === "number" ? value[0] : value;
}
function parseISO(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : NaN;
}
function fromDbTime(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string" && !(value instanceof Date)) throw new Error("PPAN_AUTO_OBSERVABILITY_SHAPE");
  return new Date(value).toISOString();
}
function exactId(value: unknown): value is string { return typeof value === "string" && WEB_BUDGET_OPERATION_ID.test(value); }
function tickReason(value: unknown): value is PpanAutoTickReason {
  return (PPAN_AUTO_TICK_REASONS as readonly unknown[]).includes(value);
}
function amount(value: unknown): number {
  const n = typeof value === "string" && /^\d{1,12}$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0 || n > WEB_BUDGET_MAX_MINOR) throw new Error("PPAN_AUTO_OBSERVABILITY_SHAPE");
  return n;
}
function historyItem(row: Record<string, unknown>): PpanAutoHistoryItem {
  const checkedAt = fromDbTime(row.updated_at);
  if (!checkedAt || !exactId(row.operation_id) || !(HISTORY_OUTCOMES as readonly unknown[]).includes(row.status)) {
    throw new Error("PPAN_AUTO_OBSERVABILITY_SHAPE");
  }
  return { operationId: row.operation_id, checkedAt, status: row.status as PpanAutoHistoryItem["status"],
    previousBudgetMinor: amount(row.current_budget_minor), targetBudgetMinor: amount(row.target_budget_minor),
    observedBudgetMinor: row.observed_budget_minor == null ? null : amount(row.observed_budget_minor),
    reason: typeof row.reason === "string" && HISTORY_REASONS.has(row.reason) ? row.reason : "UNCLASSIFIED" };
}
function validAlert(item: unknown): item is PpanAutoAlertCandidate {
  if (!item || typeof item !== "object") return false;
  const value = item as Partial<PpanAutoAlertCandidate>;
  return exactId(value.sessionId) && (ALERT_KINDS as readonly unknown[]).includes(value.kind) &&
    (value.kind === "OUTCOME_UNKNOWN" ? exactId(value.incidentKey) : typeof value.incidentKey === "string" && /^\d{1,18}$/.test(value.incidentKey));
}

export function createPpanAutoObservabilityStore(database: CreatorWebBudgetDatabase) {
  async function run<T>(work: (runner: Runner) => Promise<T>, readOnly = false): Promise<T> {
    const runner = database.createQueryRunner();
    let begun = false;
    try {
      await runner.connect();
      await runner.query(readOnly ? "BEGIN READ ONLY" : "BEGIN"); begun = true;
      await runner.query("SET LOCAL lock_timeout = '750ms'");
      await runner.query("SET LOCAL statement_timeout = '1500ms'");
      const result = await work(runner);
      await runner.query("COMMIT"); begun = false;
      return result;
    } catch {
      if (begun) { try { await runner.query("ROLLBACK"); } catch { /* Diagnostic failure cannot permit any send. */ } }
      throw new Error("PPAN_AUTO_OBSERVABILITY_UNAVAILABLE");
    } finally { try { await runner.release(); } catch { /* Do not surface connection details. */ } }
  }
  return {
    async ensureSchema() { await run(async runner => { await runner.query(SCHEMA); }); },
    async recordTick(input: PpanAutoTickObservation) {
      const checked = parseISO(input.checkedAt);
      const observed = input.lastValidReadAt == null ? checked : parseISO(input.lastValidReadAt);
      if (!Number.isFinite(checked) || !Number.isFinite(observed) || observed > checked || !tickReason(input.reason) ||
        (input.sessionId != null && !exactId(input.sessionId))) throw new Error("PPAN_AUTO_OBSERVABILITY_INPUT");
      await run(async runner => { await runner.query(WRITE_TICK, [input.sessionId ?? null, input.checkedAt, input.lastValidReadAt ?? null, input.reason]); });
    },
    async status(ownerId: number): Promise<PpanAutoObservabilityStatus> {
      if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error("PPAN_AUTO_OBSERVABILITY_INPUT");
      return run(async runner => {
        const [health] = asRows(await runner.query(READ_HEALTH, [ownerId]));
        const history = asRows(await runner.query(READ_HISTORY, [ownerId])).map(historyItem);
        return { lastTickAt: fromDbTime(health?.checked_at), lastValidReadAt: fromDbTime(health?.last_valid_read_at),
          reason: tickReason(health?.reason) ? health.reason : null, heartbeatStale: health?.heartbeat_stale === true, history };
      }, true);
    },
    async watchdog(): Promise<PpanAutoAlertCandidate | null> {
      return run(async runner => {
        const [row] = asRows(await runner.query(`${ALERT_CANDIDATE}
          SELECT f.* FROM findings f WHERE NOT EXISTS (SELECT 1 FROM ${ALERT_TABLE} a
            WHERE a.client_id='${SCOPE}' AND a.session_id=f.session_id AND a.kind=f.kind AND a.incident_key=f.incident_key
              AND a.accepted_at IS NOT NULL) ORDER BY f.priority LIMIT 1`));
        if (!row) return null;
        const candidate = { sessionId: row.session_id, kind: row.kind, incidentKey: row.incident_key };
        if (!validAlert(candidate)) throw new Error("PPAN_AUTO_OBSERVABILITY_SHAPE");
        return candidate;
      }, true);
    },
    async watchState(replacePersistentReadAlert = false): Promise<PpanAutoWatchState> {
      return run(async runner => {
        const [row] = asRows(await runner.query(`${ALERT_CANDIDATE}
          SELECT s.session_id,s.status,f.kind,f.incident_key FROM latest s LEFT JOIN LATERAL (
            SELECT f.kind,f.incident_key FROM findings f WHERE NOT EXISTS (SELECT 1 FROM ${ALERT_TABLE} a
              WHERE a.client_id='${SCOPE}' AND a.session_id=f.session_id AND a.kind=f.kind AND a.incident_key=f.incident_key
                AND a.accepted_at IS NOT NULL)
              AND NOT ($1::boolean AND f.kind='CHECKS_FAILING' AND f.keep_auto_across_rooms
                AND f.health_reason IS NOT DISTINCT FROM 'CONTEXT_UNAVAILABLE')
            ORDER BY f.priority LIMIT 1
          ) f ON true`, [replacePersistentReadAlert]));
        if (!row) return { armState: "INACTIVE", sessionId: null, incident: null };
        if (!exactId(row.session_id) || !["ACTIVE","BLOCKED","STOPPED"].includes(String(row.status))) throw new Error("PPAN_AUTO_OBSERVABILITY_SHAPE");
        const incident = row.kind == null ? null : { sessionId: row.session_id, kind: row.kind, incidentKey: row.incident_key };
        if (incident && !validAlert(incident)) throw new Error("PPAN_AUTO_OBSERVABILITY_SHAPE");
        return { armState: row.status === "ACTIVE" || row.status === "BLOCKED" ? "ACTIVE" : "INACTIVE",
          sessionId: row.session_id, incident: incident as PpanAutoAlertCandidate | null };
      }, true);
    },
    async reserveAlert(candidate: PpanAutoAlertCandidate, retryKey: string): Promise<string | null> {
      if (!validAlert(candidate) || !exactId(retryKey)) throw new Error("PPAN_AUTO_OBSERVABILITY_INPUT");
      return run(async runner => {
        const [row] = asRows(await runner.query(`${ALERT_CANDIDATE}
          INSERT INTO ${ALERT_TABLE} AS existing (client_id,session_id,kind,incident_key,retry_key)
          SELECT '${SCOPE}',f.session_id,f.kind,f.incident_key,$4::uuid FROM findings f
          WHERE f.session_id=$1::uuid AND f.kind=$2 AND f.incident_key=$3
          ON CONFLICT (client_id,session_id,kind,incident_key) DO UPDATE SET retry_key=existing.retry_key
          WHERE existing.accepted_at IS NULL RETURNING retry_key`, [candidate.sessionId, candidate.kind, candidate.incidentKey, retryKey]));
        return row && exactId(row.retry_key) ? row.retry_key : null;
      });
    },
    async markAlertAccepted(candidate: PpanAutoAlertCandidate, retryKey: string): Promise<boolean> {
      if (!validAlert(candidate) || !exactId(retryKey)) throw new Error("PPAN_AUTO_OBSERVABILITY_INPUT");
      return run(async runner => asRows(await runner.query(`UPDATE ${ALERT_TABLE} SET accepted_at=clock_timestamp()
        WHERE client_id='${SCOPE}' AND session_id=$1::uuid AND kind=$2 AND incident_key=$3 AND retry_key=$4::uuid
          AND accepted_at IS NULL RETURNING 1`, [candidate.sessionId, candidate.kind, candidate.incidentKey, retryKey])).length === 1);
    },
  };
}
