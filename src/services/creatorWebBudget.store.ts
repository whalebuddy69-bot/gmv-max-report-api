import {
  WEB_BUDGET_CAMPAIGN_ID, WEB_BUDGET_MAX_MINOR, WEB_BUDGET_OPERATION_ID,
  WebBudgetError, WebBudgetRecord, WebBudgetStore,
} from "./creatorWebBudget.service";
import { PPAN_CAMPAIGN_ACTION_FENCE_SQL, PPAN_CAMPAIGN_BUDGET_LOCK_SQL, PPAN_CAMPAIGN_OPERATIONS } from "./creatorCampaignActions.store";
import type { CreatorBudgetScope } from "./creatorBudgetScope";

export type CreatorWebBudgetLedgerClient = CreatorBudgetScope;
const PPAN_LEDGER = { clientId: "punpan_020", table: "creator_web_budget_operations", fence: "creator_web_budget_one_active_fence" } as const;
const SRIHIW_LEDGER = { clientId: "srihiw", table: "creator_web_budget_srihiw_operations", fence: "creator_web_budget_srihiw_one_active_fence" } as const;
const NNSHOP_LEDGER = { clientId: "nnshop5719", table: "creator_web_budget_nnshop5719_operations",
  fence: "creator_web_budget_nnshop5719_one_active_fence" } as const;
const ASHOP_LEDGER = { clientId: "ashopbytheta", table: "creator_web_budget_ashopbytheta_operations",
  fence: "creator_web_budget_ashopbytheta_one_active_fence" } as const;
const MYU_LEDGER = { clientId: "myushop4", table: "creator_web_budget_myushop4_operations", fence: "creator_web_budget_myushop4_one_active_fence" } as const;
const BUBPA_LEDGER = { clientId: "bubpa_shop189", table: "creator_web_budget_bubpa_shop189_operations", fence: "creator_web_budget_bubpa_shop189_one_active_fence" } as const;
type LedgerScope = typeof PPAN_LEDGER | typeof SRIHIW_LEDGER | typeof NNSHOP_LEDGER | typeof ASHOP_LEDGER | typeof MYU_LEDGER | typeof BUBPA_LEDGER;

function ledgerScope(clientId: CreatorWebBudgetLedgerClient): LedgerScope {
  if (clientId === "punpan_020") return PPAN_LEDGER;
  if (clientId === "srihiw") return SRIHIW_LEDGER;
  if (clientId === "nnshop5719") return NNSHOP_LEDGER;
  if (clientId === "ashopbytheta") return ASHOP_LEDGER;
  if (clientId === "myushop4") return MYU_LEDGER;
  if (clientId === "bubpa_shop189") return BUBPA_LEDGER;
  throw new Error("Unconfigured Creator budget ledger");
}

// Additive, independently fenced ledgers. Identifiers only come from the
// code-owned scopes above. The readback fingerprint is added without changing existing rows.
function schemaSql({ clientId, table, fence }: LedgerScope) { return `
CREATE TABLE IF NOT EXISTS ${table} (
  operation_id uuid PRIMARY KEY,
  client_id text NOT NULL DEFAULT '${clientId}' CHECK (client_id = '${clientId}'),
  owner_id bigint NOT NULL CHECK (owner_id > 0),
  mode text NOT NULL CHECK (mode IN ('dry-run','live')),
  campaign_id text NOT NULL CHECK (campaign_id ~ '^[1-9][0-9]{5,30}$'),
  reporting_date text NOT NULL CHECK (reporting_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  current_budget_minor bigint NOT NULL CHECK (current_budget_minor > 0),
  target_budget_minor bigint NOT NULL CHECK (target_budget_minor > 0 AND target_budget_minor <> current_budget_minor),
  projected_client_spend_minor bigint NOT NULL CHECK (projected_client_spend_minor >= target_budget_minor),
  policy_revision bigint NOT NULL CHECK (policy_revision > 0),
  campaign_cap_minor bigint NOT NULL CHECK (campaign_cap_minor >= target_budget_minor),
  client_daily_cap_minor bigint NOT NULL CHECK (client_daily_cap_minor >= projected_client_spend_minor),
  cap_read_at timestamptz NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PREPARED' CHECK (status IN ('PREPARED','PROCESSING','SIMULATED','NOT_SENT','PROVIDER_REJECTED','APPLIED_VERIFIED','OUTCOME_UNKNOWN')),
  observed_budget_minor bigint,
  reason text NOT NULL DEFAULT 'PREPARED' CHECK (reason ~ '^[A-Z0-9_]{1,100}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reserved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (status <> 'SIMULATED' OR mode = 'dry-run'),
  CHECK (status NOT IN ('PROVIDER_REJECTED','APPLIED_VERIFIED','OUTCOME_UNKNOWN') OR mode = 'live'),
  CHECK (CASE WHEN status = 'APPLIED_VERIFIED' THEN observed_budget_minor IS NOT NULL AND observed_budget_minor = target_budget_minor
    ELSE observed_budget_minor IS NULL END)
);
CREATE UNIQUE INDEX IF NOT EXISTS ${fence}
  ON ${table} (client_id) WHERE status IN ('PROCESSING','OUTCOME_UNKNOWN');
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','auto'));
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS observed_fingerprint text
  CHECK (observed_fingerprint IS NULL OR (status = 'APPLIED_VERIFIED' AND observed_fingerprint ~ '^[a-f0-9]{64}$' AND observed_fingerprint <> fingerprint));
`; }
export const CREATOR_WEB_BUDGET_SCHEMA_SQL = schemaSql(PPAN_LEDGER);

interface QueryRunner {
  connect(): Promise<unknown>;
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
  release(): Promise<unknown>;
}
export interface CreatorWebBudgetDatabase { createQueryRunner(): QueryRunner; }
const statusValues = new Set(["PREPARED", "PROCESSING", "SIMULATED", "NOT_SENT", "PROVIDER_REJECTED", "APPLIED_VERIFIED", "OUTCOME_UNKNOWN"]);
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Unexpected ledger driver result");
  // TypeORM/PostgreSQL UPDATE returns [rows, affectedCount]; SELECT/INSERT return rows.
  return Array.isArray(value[0]) && typeof value[1] === "number" ? value[0] : value;
}
function safeInteger(input: unknown, max = Number.MAX_SAFE_INTEGER): number {
  const value = typeof input === "number" ? input : typeof input === "string" && /^\d+$/.test(input) ? Number(input) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new Error("Unexpected ledger integer");
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" && !(value instanceof Date)) throw new Error("Unexpected ledger timestamp");
  return new Date(value).toISOString();
}
function operation(row: Record<string, unknown>, expectedClientId: CreatorWebBudgetLedgerClient): WebBudgetRecord {
  if (typeof row.operation_id !== "string" || !WEB_BUDGET_OPERATION_ID.test(row.operation_id)
    || (row.mode !== "dry-run" && row.mode !== "live") || row.client_id !== expectedClientId
    || (row.source !== "manual" && row.source !== "auto") || (row.source === "auto" && row.mode !== "live")
    || typeof row.campaign_id !== "string" || !WEB_BUDGET_CAMPAIGN_ID.test(row.campaign_id)
    || typeof row.reporting_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.reporting_date)
    || typeof row.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.fingerprint)
    || typeof row.status !== "string" || !statusValues.has(row.status)
    || (row.observed_fingerprint != null && (typeof row.observed_fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.observed_fingerprint) || row.observed_fingerprint === row.fingerprint || row.status !== "APPLIED_VERIFIED"))) throw new Error("Unexpected ledger record");
  return { operationId: row.operation_id, ownerId: safeInteger(row.owner_id), mode: row.mode, source: row.source, campaignId: row.campaign_id,
    reportingDate: row.reporting_date, currentBudgetMinor: safeInteger(row.current_budget_minor, WEB_BUDGET_MAX_MINOR),
    targetBudgetMinor: safeInteger(row.target_budget_minor, WEB_BUDGET_MAX_MINOR),
    projectedClientSpendMinor: safeInteger(row.projected_client_spend_minor, WEB_BUDGET_MAX_MINOR),
    cap: { revision: safeInteger(row.policy_revision), campaignCapMinor: safeInteger(row.campaign_cap_minor, WEB_BUDGET_MAX_MINOR),
      clientDailyCapMinor: safeInteger(row.client_daily_cap_minor, WEB_BUDGET_MAX_MINOR), readAt: timestamp(row.cap_read_at), locked: false },
    fingerprint: row.fingerprint, expiresAt: timestamp(row.expires_at), status: row.status as WebBudgetRecord["status"],
    observedBudgetMinor: row.observed_budget_minor === null ? null : safeInteger(row.observed_budget_minor, WEB_BUDGET_MAX_MINOR),
    ...(typeof row.observed_fingerprint === "string" ? { observedFingerprint: row.observed_fingerprint } : {}) };
}
export function createCreatorWebBudgetStore(database: CreatorWebBudgetDatabase, clientId: CreatorWebBudgetLedgerClient = "punpan_020"): WebBudgetStore & { ensureSchema(): Promise<void> } {
  const scope = ledgerScope(clientId);
  const { table } = scope;
  async function campaignActionFenced(runner: QueryRunner, reserve: boolean) {
    if (clientId !== "punpan_020") return false;
    if (reserve) await runner.query(PPAN_CAMPAIGN_BUDGET_LOCK_SQL);
    const exists = rows(await runner.query("SELECT to_regclass($1) IS NOT NULL AS present", [PPAN_CAMPAIGN_OPERATIONS]));
    if (exists.length !== 1 || typeof exists[0].present !== "boolean") throw new Error("Unexpected campaign fence readiness");
    return exists[0].present && rows(await runner.query(PPAN_CAMPAIGN_ACTION_FENCE_SQL)).length > 0;
  }
  function selectOwned(runner: QueryRunner, ownerId: number, operationId: string) {
    return runner.query(`SELECT * FROM ${table} WHERE client_id=$3 AND owner_id=$1 AND operation_id=$2`, [ownerId, operationId, clientId]);
  }
  async function run<T>(work: (runner: QueryRunner) => Promise<T>, allowCollision = false): Promise<T | null> {
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
    } catch (error) {
      if (begun) { try { await runner.query("ROLLBACK"); } catch { /* Ambiguous commit never permits a dispatch. */ } }
      if (allowCollision && (error as { code?: string } | null)?.code === "23505") return null;
      throw new WebBudgetError("BUDGET_LEDGER_UNAVAILABLE", 503, "ยังยืนยันสถานะรายการไม่ได้ ห้ามส่งซ้ำจนกว่าจะตรวจสอบผล");
    } finally { try { await runner.release(); } catch { /* No connection metadata in responses. */ } }
  }
  return {
    async ensureSchema() { await run(async runner => { await runner.query(schemaSql(scope)); }); },
    async create(value) {
      await run(async runner => {
        await runner.query(`INSERT INTO ${table}
          (operation_id,owner_id,mode,campaign_id,reporting_date,current_budget_minor,target_budget_minor,
            projected_client_spend_minor,policy_revision,campaign_cap_minor,client_daily_cap_minor,cap_read_at,fingerprint,expires_at,source)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [value.operationId, value.ownerId, value.mode, value.campaignId, value.reportingDate,
          value.currentBudgetMinor, value.targetBudgetMinor, value.projectedClientSpendMinor,
          value.cap.revision, value.cap.campaignCapMinor, value.cap.clientDailyCapMinor, value.cap.readAt, value.fingerprint, value.expiresAt, value.source ?? "manual"]);
      });
    },
    async get(ownerId, operationId) {
      return run(async runner => {
        const found = rows(await selectOwned(runner, ownerId, operationId));
        return found.length === 1 ? operation(found[0], clientId) : null;
      });
    },
    async hasFence() {
      return await run(async runner => await campaignActionFenced(runner, false) || rows(await runner.query(`SELECT 1 FROM ${table}
        WHERE client_id=$1 AND (status='OUTCOME_UNKNOWN' OR
          (status='PROCESSING' AND (mode='live' OR expires_at > clock_timestamp()))) LIMIT 1`, [clientId])).length > 0) !== false;
    },
    async reserve(ownerId, operationId, mode) {
      return run(async runner => {
        if (await campaignActionFenced(runner, true)) return null;
        // Expired simulations provably cannot have sent. NEVER recycle a live fence here.
        await runner.query(`UPDATE ${table} SET status='NOT_SENT', reason='SIMULATION_EXPIRED_NO_PROVIDER_WRITE', updated_at=clock_timestamp()
          WHERE client_id=$1 AND status='PROCESSING' AND mode='dry-run' AND expires_at <= clock_timestamp()`, [clientId]);
        const matched = rows(await runner.query(`UPDATE ${table}
          SET status='PROCESSING', reason='SEND_FENCE_COMMITTED', reserved_at=clock_timestamp(), updated_at=clock_timestamp()
          WHERE client_id=$4 AND owner_id=$1 AND operation_id=$2 AND mode=$3 AND status='PREPARED'
            AND expires_at > clock_timestamp()
          RETURNING *`, [ownerId, operationId, mode, clientId]));
        return matched.length === 1 ? operation(matched[0], clientId) : null;
      }, true);
    },
    async finish(ownerId, operationId, value) {
      const completed = await run(async runner => {
        const matched = rows(await runner.query(`UPDATE ${table}
          SET status=$3, observed_budget_minor=$4, reason=$5, observed_fingerprint=$7, updated_at=clock_timestamp()
          WHERE client_id=$6 AND owner_id=$1 AND operation_id=$2 AND status='PROCESSING' RETURNING *`,
        [ownerId, operationId, value.status, value.observedBudgetMinor, value.reason, clientId, value.observedFingerprint ?? null]));
        if (matched.length === 1) return operation(matched[0], clientId);
        const found = rows(await selectOwned(runner, ownerId, operationId));
        if (found.length !== 1 || found[0].status === "PROCESSING" || found[0].status === "PREPARED") throw new Error("Ledger record not terminal");
        return operation(found[0], clientId);
      });
      if (!completed) throw new WebBudgetError("BUDGET_LEDGER_UNAVAILABLE", 503, "ยังยืนยันสถานะรายการไม่ได้ ห้ามส่งซ้ำจนกว่าจะตรวจสอบผล");
      return completed;
    },
  };
}
