import { bangkokDay } from "./creatorRead.service";
import {
  WEB_BUDGET_CAMPAIGN_ID, WEB_BUDGET_MAX_MINOR, WEB_BUDGET_OPERATION_ID,
  type WebBudgetContext, type WebBudgetPolicy,
} from "./creatorWebBudget.service";
import type { CreatorWebBudgetDatabase } from "./creatorWebBudget.store";
import type { LegacyAutoBudgetScope } from "./creatorBudgetScope";

export type CreatorAutoBudgetClientId = LegacyAutoBudgetScope;
export const CREATOR_AUTO_BUDGET_MAX_GRANT_MS = 2 * 60 * 60 * 1000;
const MIN_REMAINING_MS = 15_000;
const READ_FRESH_MS = 30_000;
const POLICY_FRESH_MS = 20_000;
const PROVIDER_SPEND_FRESH_MS = 5 * 60_000;
const MAX_MONEY = BigInt(WEB_BUDGET_MAX_MINOR);
const FINGERPRINT = /^[a-f0-9]{64}$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface CreatorAutoBudgetGrant {
  grantId: string;
  clientId: CreatorAutoBudgetClientId;
  ownerId: number;
  campaignId: string;
  reportingDate: string;
  policyRevision: number;
  expectedBudgetMinor: number;
  fingerprint: string;
  authorizedAt: string;
  expiresAt: string;
  nativeAutoOffAttested: true;
  noConcurrentChangesAttested: true;
}

export interface CreatorAutoBudgetGrantRecord extends CreatorAutoBudgetGrant {
  status: "ARMED" | "RESERVED" | "REVOKED" | "COMPLETED";
  operationId: string | null;
  settledAt?: string | null;
}

export type CreatorAutoBudgetContext = WebBudgetContext & {
  // A verified provider data watermark, NOT the time the application fetched the response.
  providerSpendObservedAt: string | null;
  // An enabled campaign alone is not proof that this live stream is delivering.
  deliveryVerified?: boolean;
};

type PreviewSkip =
  "CONTEXT_UNVERIFIED" | "POLICY_UNAVAILABLE" | "POLICY_LOCKED" | "BELOW_THRESHOLD" |
  "TARGET_NOT_EXACT" | "TARGET_BELOW_SPEND" | "CAMPAIGN_CAP_EXCEEDED" | "CLIENT_DAILY_CAP_EXCEEDED";
type ExecutionSkip = PreviewSkip |
  "NOT_ARMED" | "GRANT_EXPIRED" | "BASELINE_CHANGED" | "UNRESOLVED_WRITE" |
  "NATIVE_AUTO_UNVERIFIED" | "PROVIDER_SPEND_STALE" | "DELIVERY_UNVERIFIED" | "NOTIFICATION_UNAVAILABLE";
interface PreviewAmounts {
  currentBudgetMinor: number;
  targetBudgetMinor: number;
  thresholdMinor: number;
  projectedClientSpendMinor: number;
  fingerprint: string;
}
export type CreatorAutoBudgetPreview = { status: PreviewSkip } | ({ status: "WOULD_INCREASE" } & PreviewAmounts);
export type CreatorAutoBudgetDecision =
  { status: ExecutionSkip } | ({ status: "ELIGIBLE"; expiresAt: string } & PreviewAmounts);

function instant(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : NaN;
}
function dateEnd(day: string): number {
  if (!LOCAL_DATE.test(day)) return NaN;
  const start = Date.parse(`${day}T00:00:00+07:00`);
  return Number.isFinite(start) && bangkokDay(new Date(start)) === day ? start + 86_400_000 : NaN;
}
function fresh(value: unknown, now: number, maxAge: number) {
  const age = now - instant(value);
  return age >= 0 && age <= maxAge;
}
function client(value: unknown): value is CreatorAutoBudgetClientId {
  return value === "punpan_020" || value === "srihiw" || value === "nnshop5719" || value === "ashopbytheta";
}
function positive(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function validGrant(value: unknown): value is CreatorAutoBudgetGrant {
  if (!value || typeof value !== "object") return false;
  const g = value as Partial<CreatorAutoBudgetGrant>;
  if (!client(g.clientId) || !positive(g.ownerId) || !positive(g.policyRevision) ||
    !positive(g.expectedBudgetMinor, WEB_BUDGET_MAX_MINOR) || typeof g.grantId !== "string" ||
    !WEB_BUDGET_OPERATION_ID.test(g.grantId) || typeof g.campaignId !== "string" ||
    !WEB_BUDGET_CAMPAIGN_ID.test(g.campaignId) || typeof g.fingerprint !== "string" ||
    !FINGERPRINT.test(g.fingerprint) || typeof g.reportingDate !== "string" ||
    g.nativeAutoOffAttested !== true || g.noConcurrentChangesAttested !== true) return false;
  const start = instant(g.authorizedAt), end = instant(g.expiresAt);
  return Number.isFinite(start) && end > start && end - start <= CREATOR_AUTO_BUDGET_MAX_GRANT_MS &&
    bangkokDay(new Date(start)) === g.reportingDate && end <= dateEnd(g.reportingDate);
}

/** The exact same target is used before arming, while waiting, and before a write. */
export function calculateCreatorAutoBudgetTarget(budgetMinor: number, rounding?: "floor-satang"): bigint | null {
  if (!positive(budgetMinor, WEB_BUDGET_MAX_MINOR)) return null;
  const baseline = BigInt(budgetMinor), scaled = baseline * 12n, target = scaled / 10n;
  return (rounding === "floor-satang" || scaled % 10n === 0n) && target > baseline && target <= MAX_MONEY ? target : null;
}

/** Pure advisory calculation. This result carries no authorization or provider freshness proof. */
export function previewCreatorAutoBudget({ now, context, policy, rounding }: {
  now: Date; context: WebBudgetContext | null; policy: WebBudgetPolicy | null; rounding?: "floor-satang";
}): CreatorAutoBudgetPreview {
  const at = now.getTime();
  if (!context || !fresh(context.observedAt, at, READ_FRESH_MS) ||
    context.reportingDate !== bangkokDay(now) || context.reportingDate !== bangkokDay(new Date(instant(context.observedAt))) ||
    typeof context.campaignId !== "string" || !WEB_BUDGET_CAMPAIGN_ID.test(context.campaignId) ||
    !positive(context.budgetMinor, WEB_BUDGET_MAX_MINOR) || !nonnegative(context.spendMinor) ||
    !nonnegative(context.aggregateSpendMinor) || context.aggregateSpendMinor < context.spendMinor ||
    typeof context.fingerprint !== "string" || !FINGERPRINT.test(context.fingerprint)) return { status: "CONTEXT_UNVERIFIED" };
  if (!policy || !positive(policy.revision) || !positive(policy.campaignCapMinor, WEB_BUDGET_MAX_MINOR) ||
    !positive(policy.clientDailyCapMinor, WEB_BUDGET_MAX_MINOR) || !fresh(policy.readAt, at, POLICY_FRESH_MS) ||
    typeof policy.locked !== "boolean") return { status: "POLICY_UNAVAILABLE" };
  if (policy.locked) return { status: "POLICY_LOCKED" };

  // One-shot scopes still require exact satang. Continuous Ppan may round down by less than one satang.
  const baseline = BigInt(context.budgetMinor);
  const threshold = (baseline * 8n + 9n) / 10n;
  if (BigInt(context.spendMinor) < threshold) return { status: "BELOW_THRESHOLD" };
  const target = calculateCreatorAutoBudgetTarget(context.budgetMinor, rounding);
  if (target === null) return { status: "TARGET_NOT_EXACT" };
  if (target <= BigInt(context.spendMinor)) return { status: "TARGET_BELOW_SPEND" };
  if (target > BigInt(policy.campaignCapMinor)) return { status: "CAMPAIGN_CAP_EXCEEDED" };
  const projected = target + BigInt(context.aggregateSpendMinor - context.spendMinor);
  if (projected > BigInt(policy.clientDailyCapMinor)) return { status: "CLIENT_DAILY_CAP_EXCEEDED" };
  return {
    status: "WOULD_INCREASE", currentBudgetMinor: context.budgetMinor, targetBudgetMinor: Number(target),
    thresholdMinor: Number(threshold), projectedClientSpendMinor: Number(projected), fingerprint: context.fingerprint,
  };
}

/** First autonomous pilot: exact scoped authorization, one attempt, and machine-verifiable off/freshness. */
export function evaluateCreatorAutoBudget({ clientId, now, grant, context, policy, hasUnresolvedWrite, notificationReady }: {
  clientId: CreatorAutoBudgetClientId;
  now: Date;
  grant: CreatorAutoBudgetGrantRecord | null;
  context: CreatorAutoBudgetContext | null;
  policy: WebBudgetPolicy | null;
  hasUnresolvedWrite: boolean;
  notificationReady: boolean;
}): CreatorAutoBudgetDecision {
  const at = now.getTime();
  if (!client(clientId) || !validGrant(grant) || grant.clientId !== clientId || grant.status !== "ARMED" ||
    grant.operationId !== null) return { status: "NOT_ARMED" };
  if (!Number.isFinite(at) || instant(grant.authorizedAt) > at || instant(grant.expiresAt) - at < MIN_REMAINING_MS ||
    grant.reportingDate !== bangkokDay(now)) return { status: "GRANT_EXPIRED" };
  if (hasUnresolvedWrite !== false) return { status: "UNRESOLVED_WRITE" };
  if (notificationReady !== true) return { status: "NOTIFICATION_UNAVAILABLE" };
  const preview = previewCreatorAutoBudget({ now, context, policy });
  if (!context || !policy) return { status: context ? "POLICY_UNAVAILABLE" : "CONTEXT_UNVERIFIED" };
  if (context.campaignId !== grant.campaignId || context.reportingDate !== grant.reportingDate ||
    context.budgetMinor !== grant.expectedBudgetMinor || context.fingerprint !== grant.fingerprint ||
    policy.revision !== grant.policyRevision) return { status: "BASELINE_CHANGED" };
  // A below-threshold report may arm an otherwise verified grant for later,
  // but never let that outcome bypass provider evidence validation at arm time.
  if (preview.status !== "WOULD_INCREASE" && preview.status !== "BELOW_THRESHOLD") return preview;
  if (context.nativeAutoState !== "DISABLED") return { status: "NATIVE_AUTO_UNVERIFIED" };
  const watermark = instant(context.providerSpendObservedAt);
  if (!fresh(context.providerSpendObservedAt, at, PROVIDER_SPEND_FRESH_MS) || watermark > instant(context.observedAt) ||
    bangkokDay(new Date(watermark)) !== context.reportingDate) return { status: "PROVIDER_SPEND_STALE" };
  if (context.deliveryVerified !== true) return { status: "DELIVERY_UNVERIFIED" };
  if (preview.status !== "WOULD_INCREASE") return preview;
  const { status: _, ...amounts } = preview;
  return { status: "ELIGIBLE", ...amounts, expiresAt: new Date(Math.min(instant(grant.expiresAt), at + 120_000)).toISOString() };
}

export const CREATOR_AUTO_BUDGET_GRANT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS creator_auto_budget_grants (
  grant_id uuid UNIQUE NOT NULL,
  client_id text NOT NULL CONSTRAINT creator_auto_budget_grants_creator_scope_v2
    CHECK (client_id IN ('punpan_020','srihiw','nnshop5719','ashopbytheta')),
  owner_id bigint NOT NULL CHECK (owner_id > 0),
  campaign_id text NOT NULL CHECK (campaign_id ~ '^[1-9][0-9]{5,30}$'),
  reporting_date date NOT NULL,
  policy_revision bigint NOT NULL CHECK (policy_revision > 0),
  expected_budget_minor bigint NOT NULL CHECK (expected_budget_minor BETWEEN 1 AND 100000000000),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  authorized_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  native_auto_off_attested boolean NOT NULL CHECK (native_auto_off_attested),
  no_concurrent_changes_attested boolean NOT NULL CHECK (no_concurrent_changes_attested),
  status text NOT NULL DEFAULT 'ARMED' CHECK (status IN ('ARMED','RESERVED','REVOKED','COMPLETED')),
  operation_id uuid UNIQUE,
  reserved_at timestamptz,
  revoked_at timestamptz,
  settled_at timestamptz,
  PRIMARY KEY (client_id, reporting_date),
  CHECK ((authorized_at AT TIME ZONE 'Asia/Bangkok')::date = reporting_date),
  CHECK (expires_at > authorized_at AND expires_at <= authorized_at + interval '2 hours'),
  CHECK (expires_at <= ((reporting_date + 1)::timestamp AT TIME ZONE 'Asia/Bangkok')),
  CHECK (status <> 'ARMED' OR (operation_id IS NULL AND reserved_at IS NULL AND revoked_at IS NULL AND settled_at IS NULL)),
  CHECK (status <> 'RESERVED' OR (operation_id IS NOT NULL AND reserved_at IS NOT NULL AND revoked_at IS NULL AND settled_at IS NULL)),
  CHECK (status <> 'COMPLETED' OR (operation_id IS NOT NULL AND reserved_at IS NOT NULL AND revoked_at IS NULL AND settled_at IS NOT NULL)),
  CHECK (settled_at IS NULL OR operation_id IS NOT NULL),
  CHECK (status <> 'REVOKED' OR revoked_at IS NOT NULL)
);

-- Upgrade only the old exact two-Creator check. Keep the same table, primary
-- key, UUID uniqueness and existing reserved/revoked records. Normal startup
-- checks catalog metadata without locking an already migrated grant table.
DO $creator_scope$
DECLARE
  old_check text;
  current_check text;
  expected_old constant text := '(client_id = ANY (ARRAY[''punpan_020''::text, ''srihiw''::text]))';
  expected_current constant text := '(client_id = ANY (ARRAY[''punpan_020''::text, ''srihiw''::text, ''nnshop5719''::text, ''ashopbytheta''::text]))';
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO old_check FROM pg_constraint
    WHERE conrelid='creator_auto_budget_grants'::regclass AND conname='creator_auto_budget_grants_client_id_check';
  SELECT pg_get_expr(conbin, conrelid) INTO current_check FROM pg_constraint
    WHERE conrelid='creator_auto_budget_grants'::regclass AND conname='creator_auto_budget_grants_creator_scope_v2' AND convalidated;
  IF old_check IS NULL AND current_check = expected_current THEN RETURN; END IF;

  LOCK TABLE creator_auto_budget_grants IN ACCESS EXCLUSIVE MODE;
  SELECT pg_get_expr(conbin, conrelid) INTO old_check FROM pg_constraint
    WHERE conrelid='creator_auto_budget_grants'::regclass AND conname='creator_auto_budget_grants_client_id_check';
  SELECT pg_get_expr(conbin, conrelid) INTO current_check FROM pg_constraint
    WHERE conrelid='creator_auto_budget_grants'::regclass AND conname='creator_auto_budget_grants_creator_scope_v2' AND convalidated;
  IF old_check IS NULL AND current_check = expected_current THEN RETURN; END IF;
  IF old_check IS DISTINCT FROM expected_old OR (current_check IS NOT NULL AND current_check <> expected_current) THEN
    RAISE EXCEPTION 'Unrecognized Creator auto grant scope';
  END IF;
  IF current_check IS NULL THEN
    ALTER TABLE creator_auto_budget_grants ADD CONSTRAINT creator_auto_budget_grants_creator_scope_v2
      CHECK (client_id IN ('punpan_020','srihiw','nnshop5719','ashopbytheta'));
  END IF;
  ALTER TABLE creator_auto_budget_grants DROP CONSTRAINT creator_auto_budget_grants_client_id_check;
END
$creator_scope$;`;

type Runner = ReturnType<CreatorWebBudgetDatabase["createQueryRunner"]>;
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("AUTO_BUDGET_LEDGER_SHAPE");
  return Array.isArray(value[0]) && typeof value[1] === "number" ? value[0] : value;
}
function utc(value: unknown): string {
  if (typeof value !== "string" && !(value instanceof Date)) throw new Error("AUTO_BUDGET_LEDGER_SHAPE");
  return new Date(value).toISOString();
}
function record(row: Record<string, unknown>): CreatorAutoBudgetGrantRecord {
  const grant = {
    grantId: row.grant_id, clientId: row.client_id, ownerId: Number(row.owner_id), campaignId: row.campaign_id,
    reportingDate: row.reporting_date, policyRevision: Number(row.policy_revision), expectedBudgetMinor: Number(row.expected_budget_minor),
    fingerprint: row.fingerprint, authorizedAt: utc(row.authorized_at), expiresAt: utc(row.expires_at),
    nativeAutoOffAttested: row.native_auto_off_attested, noConcurrentChangesAttested: row.no_concurrent_changes_attested,
  };
  const op = row.operation_id, status = row.status, settledAt = row.settled_at === null ? null : utc(row.settled_at);
  if (!validGrant(grant) || (status !== "ARMED" && status !== "RESERVED" && status !== "REVOKED" && status !== "COMPLETED") ||
    !(op === null || typeof op === "string" && WEB_BUDGET_OPERATION_ID.test(op)) ||
    (status === "ARMED" && op !== null) || (status === "RESERVED" && op === null) ||
    (status === "COMPLETED" && (op === null || settledAt === null))) throw new Error("AUTO_BUDGET_LEDGER_SHAPE");
  return { ...grant, status, operationId: op, settledAt };
}
function one(value: unknown): CreatorAutoBudgetGrantRecord | null {
  const result = rows(value);
  if (result.length > 1) throw new Error("AUTO_BUDGET_LEDGER_SHAPE");
  return result.length ? record(result[0]) : null;
}
const RETURN = `grant_id, client_id, owner_id, campaign_id, to_char(reporting_date, 'YYYY-MM-DD') AS reporting_date,
  policy_revision, expected_budget_minor, fingerprint, authorized_at, expires_at, native_auto_off_attested,
  no_concurrent_changes_attested, status, operation_id, settled_at`;
const EXACT = `client_id=$1 AND reporting_date=$2::date AND grant_id=$3::uuid AND owner_id=$4
  AND campaign_id=$5 AND policy_revision=$6 AND expected_budget_minor=$7 AND fingerprint=$8
  AND authorized_at=$9::timestamptz AND expires_at=$10::timestamptz
  AND native_auto_off_attested AND no_concurrent_changes_attested`;
function args(grant: CreatorAutoBudgetGrant) {
  return [grant.clientId, grant.reportingDate, grant.grantId, grant.ownerId, grant.campaignId, grant.policyRevision,
    grant.expectedBudgetMinor, grant.fingerprint, grant.authorizedAt, grant.expiresAt];
}

/**
 * Durable one-shot authorization only. The existing web budget ledger and control-service lease must
 * also be reserved before sending; this grant table never authorizes or records a TikTok write by itself.
 */
export function createCreatorAutoBudgetGrantStore(database: CreatorWebBudgetDatabase) {
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
      if (begun) { try { await runner.query("ROLLBACK"); } catch { /* uncertain commit must never permit a send */ } }
      throw new Error("AUTO_BUDGET_GRANT_STORE_UNAVAILABLE");
    } finally { try { await runner.release(); } catch { /* never leak DB details */ } }
  }
  return {
    async ensureSchema() { await run(async runner => { await runner.query(CREATOR_AUTO_BUDGET_GRANT_SCHEMA_SQL); }); },
    async arm(grant: CreatorAutoBudgetGrant) {
      if (!validGrant(grant)) return null;
      return run(async runner => one(await runner.query(`INSERT INTO creator_auto_budget_grants
        (client_id, reporting_date, grant_id, owner_id, campaign_id, policy_revision, expected_budget_minor,
         fingerprint, authorized_at, expires_at, native_auto_off_attested, no_concurrent_changes_attested)
        SELECT $1, $2::date, $3::uuid, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, true, true
        WHERE $9::timestamptz <= clock_timestamp() AND $9::timestamptz >= clock_timestamp() - interval '30 seconds'
          AND $10::timestamptz > clock_timestamp() + interval '15 seconds'
        ON CONFLICT DO NOTHING RETURNING ${RETURN}`, args(grant))));
    },
    async get(clientId: CreatorAutoBudgetClientId, reportingDate: string) {
      if (!client(clientId) || !Number.isFinite(dateEnd(reportingDate))) return null;
      return run(async runner => one(await runner.query(`SELECT ${RETURN} FROM creator_auto_budget_grants
        WHERE client_id=$1 AND reporting_date=$2::date`, [clientId, reportingDate])));
    },
    async reserve(grant: CreatorAutoBudgetGrant, operationId: string) {
      if (!validGrant(grant) || typeof operationId !== "string" || !WEB_BUDGET_OPERATION_ID.test(operationId)) return null;
      return run(async runner => one(await runner.query(`UPDATE creator_auto_budget_grants
        SET status='RESERVED', operation_id=$11::uuid, reserved_at=clock_timestamp()
        WHERE ${EXACT} AND status='ARMED' AND authorized_at <= clock_timestamp()
          AND expires_at > clock_timestamp() + interval '15 seconds'
        RETURNING ${RETURN}`, [...args(grant), operationId])));
    },
    async isReserved(grant: CreatorAutoBudgetGrant, operationId: string) {
      if (!validGrant(grant) || typeof operationId !== "string" || !WEB_BUDGET_OPERATION_ID.test(operationId)) return false;
      return run(async runner => rows(await runner.query(`SELECT 1 FROM creator_auto_budget_grants
        WHERE ${EXACT} AND status='RESERVED' AND operation_id=$11::uuid
          AND authorized_at <= clock_timestamp() AND expires_at > clock_timestamp()
        LIMIT 1`, [...args(grant), operationId])).length === 1);
    },
    // Only after the existing web ledger and notification handoff have a known terminal result.
    async close(grant: CreatorAutoBudgetGrant, operationId: string) {
      if (!validGrant(grant) || typeof operationId !== "string" || !WEB_BUDGET_OPERATION_ID.test(operationId)) return null;
      return run(async runner => one(await runner.query(`UPDATE creator_auto_budget_grants
        SET status=CASE WHEN status='RESERVED' THEN 'COMPLETED' ELSE status END,
          settled_at=COALESCE(settled_at,clock_timestamp())
        WHERE ${EXACT} AND status IN ('RESERVED','REVOKED','COMPLETED') AND operation_id=$11::uuid
        RETURNING ${RETURN}`, [...args(grant), operationId])));
    },
    async cancel(clientId: CreatorAutoBudgetClientId, reportingDate: string, grantId: string, ownerId: number) {
      if (!client(clientId) || !Number.isFinite(dateEnd(reportingDate)) || typeof grantId !== "string" ||
        !WEB_BUDGET_OPERATION_ID.test(grantId) || !positive(ownerId)) return null;
      return run(async runner => one(await runner.query(`UPDATE creator_auto_budget_grants
        SET status='REVOKED', revoked_at=COALESCE(revoked_at,clock_timestamp())
        WHERE client_id=$1 AND reporting_date=$2::date AND grant_id=$3::uuid AND owner_id=$4 AND status <> 'COMPLETED'
        RETURNING ${RETURN}`, [clientId, reportingDate, grantId, ownerId])));
    },
  };
}
