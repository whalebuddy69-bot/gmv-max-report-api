import { CreatorBudgetTestError, CreatorBudgetTestOperation, CreatorBudgetTestPermit, CreatorBudgetTestStatus,
  CreatorBudgetTestStore, creatorBudgetTestPermitSchema } from "./creatorBudgetTest.service";

export const CREATOR_BUDGET_TEST_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS creator_budget_test_operations (
  permit_id text PRIMARY KEY CHECK (permit_id ~ '^[A-Za-z0-9_-]{8,100}$'),
  client_id text NOT NULL CHECK (client_id = 'punpan_020'),
  local_date date NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  permit jsonb NOT NULL,
  baseline jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('SEND_RESERVED','SUCCEEDED','FAILED_REJECTED','FAILED_NOT_SENT',
    'OUTCOME_UNKNOWN','RECONCILED_TARGET_OBSERVED','CONFLICT_OBSERVED')),
  post_count smallint NOT NULL DEFAULT 1 CHECK (post_count = 1),
  provider_accepted boolean,
  observed_budget_minor bigint CHECK (observed_budget_minor >= 0),
  reason text NOT NULL CHECK (reason ~ '^[A-Z0-9_]{1,100}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, local_date)
)`;
interface BudgetTestRunner {
  connect(): Promise<unknown>;
  query(sql: string, parameters?: any[]): Promise<any>;
  release(): Promise<unknown>;
}
/** Only this own additive table is written. No report/OAuth/ad tables are changed. */
export interface BudgetTestDatabase { createQueryRunner(): BudgetTestRunner; }
const statuses: CreatorBudgetTestStatus[] = ["SEND_RESERVED", "SUCCEEDED", "FAILED_REJECTED", "FAILED_NOT_SENT",
  "OUTCOME_UNKNOWN", "RECONCILED_TARGET_OBSERVED", "CONFLICT_OBSERVED"];
function operation(row: Record<string, any>): CreatorBudgetTestOperation {
  const permit = creatorBudgetTestPermitSchema.parse(row.permit);
  const observed = row.observed_budget_minor === null ? null : Number(row.observed_budget_minor);
  if (row.permit_id !== permit.permitId || !/^[a-f0-9]{64}$/.test(row.fingerprint)
    || !statuses.includes(row.status) || Number(row.post_count) !== 1
    || ![true, false, null].includes(row.provider_accepted)
    || (observed !== null && (!Number.isSafeInteger(observed) || observed < 0))
    || typeof row.reason !== "string" || !/^[A-Z0-9_]{1,100}$/.test(row.reason)) throw new Error("LEDGER_ROW_UNVERIFIED");
  return { permitId: row.permit_id, fingerprint: row.fingerprint, permit, status: row.status,
    postCount: 1, providerAccepted: row.provider_accepted, observedBudgetMinor: observed, reason: row.reason,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
}
export function createCreatorBudgetTestStore(database: BudgetTestDatabase): CreatorBudgetTestStore {
  async function run<T>(transaction: boolean, work: (runner: BudgetTestRunner) => Promise<T>): Promise<T> {
    const runner = database.createQueryRunner();
    let begun = false;
    try {
      await runner.connect();
      if (transaction) { await runner.query("BEGIN"); begun = true; await runner.query("SET LOCAL statement_timeout = '5s'"); }
      const value = await work(runner);
      if (begun) { await runner.query("COMMIT"); begun = false; }
      return value;
    } catch (error) {
      if (begun) { try { await runner.query("ROLLBACK"); } catch { /* uncertain commit is never permission to send */ } }
      if (error instanceof CreatorBudgetTestError) throw error;
      throw new CreatorBudgetTestError("BUDGET_TEST_LEDGER_UNAVAILABLE");
    } finally { try { await runner.release(); } catch { /* never reflect connection details */ } }
  }
  return {
    async ensureSchema() { await run(false, async runner => { await runner.query(CREATOR_BUDGET_TEST_SCHEMA_SQL); }); },
    async get(permitId) {
      return run(false, async runner => {
        const rows = await runner.query("SELECT * FROM creator_budget_test_operations WHERE permit_id = $1", [permitId]);
        return rows.length ? operation(rows[0]) : null;
      });
    },
    async reserve(permit: CreatorBudgetTestPermit, fingerprint: string, baseline: Record<string, any>) {
      return run(true, async runner => {
        const rows = await runner.query(`INSERT INTO creator_budget_test_operations
          (permit_id,client_id,local_date,fingerprint,permit,baseline,status,post_count,reason)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,'SEND_RESERVED',1,'PERMANENT_SEND_FENCE_COMMITTED')
          ON CONFLICT DO NOTHING RETURNING *`, [permit.permitId, permit.clientId, permit.localDate, fingerprint,
          JSON.stringify(permit), JSON.stringify(baseline)]);
        if (rows.length) return { created: true, operation: operation(rows[0]) };
        const existing = await runner.query("SELECT * FROM creator_budget_test_operations WHERE permit_id = $1 FOR UPDATE", [permit.permitId]);
        if (!existing.length) throw new CreatorBudgetTestError("DAY_TEST_ALREADY_RESERVED", 409);
        return { created: false, operation: operation(existing[0]) };
      });
    },
    async finish(permitId, fingerprint, value) {
      return run(true, async runner => {
        // Proven results cannot be overwritten by an older, concurrent reconciliation GET.
        const raw = await runner.query(`UPDATE creator_budget_test_operations SET status=$3,
          provider_accepted=CASE WHEN provider_accepted IS TRUE THEN true ELSE $4::boolean END,
          observed_budget_minor=$5,reason=$6,updated_at=now()
          WHERE permit_id=$1 AND fingerprint=$2 AND status NOT IN ('SUCCEEDED','FAILED_REJECTED','FAILED_NOT_SENT')
          RETURNING *`, [permitId, fingerprint, value.status, value.providerAccepted, value.observedBudgetMinor, value.reason]);
        // TypeORM's PostgreSQL QueryRunner returns [rows, affectedCount] for UPDATE,
        // unlike SELECT/INSERT. Keep that driver shape out of the ledger contract.
        const rows = Array.isArray(raw?.[0]) && typeof raw?.[1] === "number" ? raw[0] : raw;
        if (rows.length) return operation(rows[0]);
        const existing = await runner.query("SELECT * FROM creator_budget_test_operations WHERE permit_id = $1 AND fingerprint = $2 FOR UPDATE", [permitId, fingerprint]);
        if (!existing.length) throw new CreatorBudgetTestError("LEDGER_OPERATION_MISSING");
        return operation(existing[0]);
      });
    },
  };
}
