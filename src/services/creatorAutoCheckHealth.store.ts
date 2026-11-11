import { randomUUID } from "node:crypto";
import type { ContinuousCreatorBudgetScope } from "./creatorBudgetScope";
import { WEB_BUDGET_OPERATION_ID } from "./creatorWebBudget.service";
import type { CreatorWebBudgetDatabase } from "./creatorWebBudget.store";

export type CreatorAutoCheckOutcome = "CHECK_FAILED" | "CHECK_VERIFIED" | "NORMAL_HOLD";
export interface CreatorAutoCheckTick {
  sessionId: string;
  /** Actual scheduler tick start, not provider-response or wall-clock handoff time. */
  checkedAt: string;
  outcome: CreatorAutoCheckOutcome;
}
export interface CreatorAutoCheckIncident {
  sessionId: string;
  incidentId: string;
  failedSince: string;
  detectedAt: string;
}

// Code-owned table names only. Match the exact durable session, not a slug
// provided by TikTok or a browser. Keep mappings explicit as scopes expand.
const SESSION_TABLE = Object.freeze({
  punpan_020: "creator_continuous_auto_budget_sessions",
  srihiw: "creator_srihiw_continuous_auto_budget_sessions",
  nnshop5719: "creator_nn_cauto_auto_budget_sessions",
  ashopbytheta: "creator_ashop_cauto_auto_budget_sessions",
  myushop4: "creator_myu_cauto_auto_budget_sessions",
  bubpa_shop189: "creator_bubpa_cauto_auto_budget_sessions",
  koolkool888: "creator_kool_cauto_auto_budget_sessions",
  boomkan: "creator_boom_cauto_auto_budget_sessions",
} satisfies Record<ContinuousCreatorBudgetScope, string>);
const OUTCOMES = new Set<CreatorAutoCheckOutcome>(["CHECK_FAILED", "CHECK_VERIFIED", "NORMAL_HOLD"]);
const THRESHOLD = 10;
const MIN_TICK_GAP_MS = 40_000;
const MAX_TICK_GAP_MS = 110_000;
const STATE = "creator_auto_check_health";
const INCIDENT = "creator_auto_check_incidents";
// Stop retrying before LINE's 24-hour retry-key lifetime. Expired and accepted
// records remain audit history and cannot become new alerts.
const NOT_EXPIRED = "i.detected_at > clock_timestamp() - interval '23 hours'";
const SCOPE_CHECK = Object.keys(SESSION_TABLE).map(scope => `'${scope}'`).join(",");
const scopeExpression = (scopes: string[]) => `(client_id = ANY (ARRAY[${scopes.map(scope => `'${scope}'::text`).join(", ")}]))`;
const LEGACY_SCOPE_EXPRESSION = scopeExpression(["punpan_020", "srihiw", "nnshop5719", "ashopbytheta", "myushop4", "bubpa_shop189", "koolkool888"]);
const CURRENT_SCOPE_EXPRESSION = scopeExpression(Object.keys(SESSION_TABLE));
const SCHEMA = `
CREATE TABLE IF NOT EXISTS ${STATE} (
  client_id text PRIMARY KEY CONSTRAINT creator_auto_check_health_scope_v2 CHECK (client_id IN (${SCOPE_CHECK})),
  session_id uuid NOT NULL,
  checked_at timestamptz NOT NULL,
  consecutive integer NOT NULL CHECK (consecutive BETWEEN 0 AND ${THRESHOLD}),
  failed_since timestamptz,
  CHECK ((consecutive = 0) = (failed_since IS NULL)),
  CHECK (failed_since IS NULL OR failed_since <= checked_at)
);
CREATE TABLE IF NOT EXISTS ${INCIDENT} (
  incident_id uuid PRIMARY KEY,
  client_id text NOT NULL CONSTRAINT creator_auto_check_incidents_scope_v2 CHECK (client_id IN (${SCOPE_CHECK})),
  session_id uuid NOT NULL,
  failed_since timestamptz NOT NULL,
  detected_at timestamptz NOT NULL,
  accepted_at timestamptz,
  UNIQUE (client_id, session_id, failed_since),
  CHECK (detected_at >= failed_since),
  CHECK (accepted_at IS NULL OR accepted_at >= detected_at)
);
CREATE INDEX IF NOT EXISTS creator_auto_check_incidents_pending
  ON ${INCIDENT} (client_id, session_id, detected_at, incident_id) WHERE accepted_at IS NULL;
`;
// Widen only the known seven-Creator checks. Existing incidents, retry keys and
// streaks remain in place; unexpected constraints are never silently replaced.
const SCOPE_UPGRADE = `
DO $creator_auto_check_scopes$
DECLARE
  table_name text;
  relation regclass;
  scope_checks name[];
  next_name text;
  observed_expression text;
  observed_valid boolean;
  versioned_present boolean;
  already_current boolean;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['${STATE}','${INCIDENT}'] LOOP
    relation := table_name::regclass;
    next_name := table_name || '_scope_v2';
    FOR pass IN 1..2 LOOP
      -- Include every client-ID CHECK, even an unvalidated or cross-column
      -- restriction. A correct v2 CHECK must not hide another unknown guard.
      SELECT array_agg(c.conname ORDER BY c.conname) INTO scope_checks
        FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
        WHERE c.conrelid=relation AND c.contype='c' AND a.attname='client_id' AND NOT a.attisdropped;
      SELECT pg_get_expr(conbin,conrelid),convalidated INTO observed_expression,observed_valid
        FROM pg_constraint WHERE conrelid=relation AND contype='c' AND conname=scope_checks[1];
      SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=relation AND conname=next_name) INTO versioned_present;
      already_current := cardinality(scope_checks)=1 AND scope_checks[1]::text=next_name AND observed_valid
        AND observed_expression=$current$${CURRENT_SCOPE_EXPRESSION}$current$;
      IF already_current THEN EXIT; END IF;
      IF pass=1 THEN EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', table_name); END IF;
    END LOOP;
    IF already_current THEN CONTINUE; END IF;
    IF cardinality(scope_checks) IS DISTINCT FROM 1 OR observed_valid IS DISTINCT FROM true OR versioned_present
      OR observed_expression IS DISTINCT FROM $legacy$${LEGACY_SCOPE_EXPRESSION}$legacy$ THEN
      RAISE EXCEPTION 'Unrecognized Creator Auto health scope constraint';
    END IF;
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (client_id IN (${SCOPE_CHECK.replaceAll("'", "''")}))', table_name, next_name);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', table_name, scope_checks[1]);
  END LOOP;
END
$creator_auto_check_scopes$;`;
type Runner = ReturnType<CreatorWebBudgetDatabase["createQueryRunner"]>;
type Row = Record<string, unknown>;

function validId(value: unknown): value is string { return typeof value === "string" && WEB_BUDGET_OPERATION_ID.test(value); }
function exactInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function dbInstant(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (exactInstant(value)) return value;
  throw new Error("CREATOR_AUTO_CHECK_HEALTH_SHAPE");
}
function table(scope: ContinuousCreatorBudgetScope): string {
  if (!Object.prototype.hasOwnProperty.call(SESSION_TABLE, scope)) throw new Error("CREATOR_AUTO_CHECK_HEALTH_INPUT");
  return SESSION_TABLE[scope];
}
function rows(result: unknown): Row[] {
  if (!Array.isArray(result)) throw new Error("CREATOR_AUTO_CHECK_HEALTH_SHAPE");
  return Array.isArray(result[0]) && typeof result[1] === "number" ? result[0] : result;
}
function incident(row: Row): CreatorAutoCheckIncident {
  if (!validId(row.incident_id) || !validId(row.session_id)) throw new Error("CREATOR_AUTO_CHECK_HEALTH_SHAPE");
  return { incidentId: row.incident_id, sessionId: row.session_id,
    failedSince: dbInstant(row.failed_since), detectedAt: dbInstant(row.detected_at) };
}

export function createCreatorAutoCheckHealthStore(database: CreatorWebBudgetDatabase) {
  async function run<T>(work: (runner: Runner) => Promise<T>, readOnly = false): Promise<T> {
    const runner = database.createQueryRunner();
    let begun = false;
    try {
      await runner.connect();
      await runner.query(readOnly ? "BEGIN READ ONLY" : "BEGIN"); begun = true;
      await runner.query("SET LOCAL lock_timeout = '750ms'");
      await runner.query("SET LOCAL statement_timeout = '3s'");
      if (!readOnly) await runner.query("SET LOCAL synchronous_commit = 'on'");
      const result = await work(runner);
      await runner.query("COMMIT"); begun = false;
      return result;
    } catch {
      if (begun) try { await runner.query("ROLLBACK"); } catch { /* Never surface driver details. */ }
      throw new Error("CREATOR_AUTO_CHECK_HEALTH_UNAVAILABLE");
    } finally { try { await runner.release(); } catch { /* No connection details. */ } }
  }

  // Select latest before checking ACTIVE. Otherwise a superseded active row
  // could satisfy a predicate, or a concurrently stopped row be skipped.
  const latest = (name: string, lock = false) => `SELECT session_id,status,keep_auto_across_rooms,authorized_at
    FROM ${name} WHERE client_id=$1 ORDER BY created_order DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`;
  const eligible = (row: Row | undefined, sessionId: string) =>
    row?.session_id === sessionId && row.status === "ACTIVE" && row.keep_auto_across_rooms === true;

  return {
    async ensureSchema() {
      await run(async runner => {
        await runner.query("SELECT pg_advisory_xact_lock(821903782, 1)");
        await runner.query(SCHEMA);
        await runner.query(SCOPE_UPGRADE);
      });
    },

    async record(scope: ContinuousCreatorBudgetScope, event: CreatorAutoCheckTick): Promise<void> {
      const name = table(scope);
      if (!event || !validId(event.sessionId) || !exactInstant(event.checkedAt) || !OUTCOMES.has(event.outcome)) {
        throw new Error("CREATOR_AUTO_CHECK_HEALTH_INPUT");
      }
      await run(async runner => {
        // Serializes observations per exact Creator alongside stop/re-arm. This
        // code never modifies the session, its policy, or any spend ledger.
        const [current] = rows(await runner.query(latest(name, true), [scope]));
        if (!eligible(current, event.sessionId)) return;
        const at = Date.parse(event.checkedAt);
        if (at < Date.parse(dbInstant(current.authorized_at))) return;
        const [clock] = rows(await runner.query("SELECT $1::timestamptz <= clock_timestamp() + interval '5 seconds' AS not_future", [event.checkedAt]));
        if (clock?.not_future !== true) return;
        const [saved] = rows(await runner.query(`SELECT session_id,checked_at,consecutive,failed_since FROM ${STATE} WHERE client_id=$1`, [scope]));
        const prior = saved?.session_id === event.sessionId ? saved : undefined;
        const gap = prior ? at - Date.parse(dbInstant(prior.checked_at)) : Infinity;
        if (gap <= 0) return; // Duplicate or reordered completion.
        const failed = event.outcome === "CHECK_FAILED";
        if (failed && gap < MIN_TICK_GAP_MS) return; // Same minute, not another poll.
        const count = prior?.consecutive ?? 0;
        if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > THRESHOLD) {
          throw new Error("CREATOR_AUTO_CHECK_HEALTH_SHAPE");
        }
        // Missed polls cannot complete an unfinished streak. Once an incident
        // exists, a pause in observations does not prove the outage ended.
        // Keep that incident saturated until a verified read or normal hold.
        const continuing = failed && count > 0 && (count === THRESHOLD || gap <= MAX_TICK_GAP_MS);
        const next = failed ? (continuing ? Math.min(count + 1, THRESHOLD) : 1) : 0;
        const failedSince = failed ? (continuing ? dbInstant(prior?.failed_since) : event.checkedAt) : null;
        await runner.query(`INSERT INTO ${STATE} (client_id,session_id,checked_at,consecutive,failed_since)
          VALUES ($1,$2::uuid,$3::timestamptz,$4,$5::timestamptz)
          ON CONFLICT (client_id) DO UPDATE SET session_id=EXCLUDED.session_id, checked_at=EXCLUDED.checked_at,
            consecutive=EXCLUDED.consecutive, failed_since=EXCLUDED.failed_since`,
        [scope, event.sessionId, event.checkedAt, next, failedSince]);
        if (next === THRESHOLD && count < THRESHOLD) await runner.query(`INSERT INTO ${INCIDENT}
          (incident_id,client_id,session_id,failed_since,detected_at) VALUES ($1::uuid,$2,$3::uuid,$4::timestamptz,$5::timestamptz)
          ON CONFLICT (client_id,session_id,failed_since) DO NOTHING`,
        [randomUUID(), scope, event.sessionId, failedSince, event.checkedAt]);
      });
    },

    async pending(scope: ContinuousCreatorBudgetScope): Promise<CreatorAutoCheckIncident | null> {
      const name = table(scope);
      return run(async runner => {
        const [row] = rows(await runner.query(`WITH current AS (${latest(name)})
          SELECT i.incident_id,i.session_id,i.failed_since,i.detected_at FROM ${INCIDENT} i JOIN current s ON i.session_id=s.session_id
          WHERE i.client_id=$1 AND s.status='ACTIVE' AND s.keep_auto_across_rooms AND i.accepted_at IS NULL AND ${NOT_EXPIRED}
          ORDER BY i.detected_at,i.incident_id LIMIT 1`, [scope]));
        return row ? incident(row) : null;
      }, true);
    },

    /** A durable Render queue acknowledgment, not proof of handset delivery. */
    async markDelivered(scope: ContinuousCreatorBudgetScope, input: Pick<CreatorAutoCheckIncident, "sessionId" | "incidentId">): Promise<boolean> {
      const name = table(scope);
      if (!input || !validId(input.sessionId) || !validId(input.incidentId)) throw new Error("CREATOR_AUTO_CHECK_HEALTH_INPUT");
      return run(async runner => {
        const [current] = rows(await runner.query(latest(name, true), [scope]));
        if (!eligible(current, input.sessionId)) return false;
        const [row] = rows(await runner.query(`UPDATE ${INCIDENT} i SET accepted_at=COALESCE(i.accepted_at,GREATEST(clock_timestamp(),i.detected_at))
          WHERE i.client_id=$1 AND i.session_id=$2::uuid AND i.incident_id=$3::uuid AND (i.accepted_at IS NOT NULL OR ${NOT_EXPIRED})
          RETURNING i.incident_id`, [scope, input.sessionId, input.incidentId]));
        return row?.incident_id === input.incidentId;
      });
    },
  };
}
