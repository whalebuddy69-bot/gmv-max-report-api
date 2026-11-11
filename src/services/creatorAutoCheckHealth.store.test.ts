import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { createCreatorAutoCheckHealthStore, type CreatorAutoCheckOutcome } from "./creatorAutoCheckHealth.store";
import type { ContinuousCreatorBudgetScope } from "./creatorBudgetScope";

const P = "punpan_020", S = "srihiw";
const sessionTables = {
  [P]: "creator_continuous_auto_budget_sessions", [S]: "creator_srihiw_continuous_auto_budget_sessions",
  nnshop5719: "creator_nn_cauto_auto_budget_sessions", ashopbytheta: "creator_ashop_cauto_auto_budget_sessions",
  myushop4: "creator_myu_cauto_auto_budget_sessions", bubpa_shop189: "creator_bubpa_cauto_auto_budget_sessions",
  koolkool888: "creator_kool_cauto_auto_budget_sessions", boomkan: "creator_boom_cauto_auto_budget_sessions",
} as const;
const oldScopes = [P, S, "nnshop5719", "ashopbytheta", "myushop4", "bubpa_shop189", "koolkool888"] as const;
const allScopes = [...oldScopes, "boomkan"] as const;
// The exact published seven-scope schema, with the original generated CHECK
// names. Do not derive it from the new schema under test.
const LEGACY_SCHEMA = `
CREATE TABLE creator_auto_check_health (
  client_id text PRIMARY KEY CHECK (client_id IN ('punpan_020','srihiw','nnshop5719','ashopbytheta','myushop4','bubpa_shop189','koolkool888')),
  session_id uuid NOT NULL, checked_at timestamptz NOT NULL,
  consecutive integer NOT NULL CHECK (consecutive BETWEEN 0 AND 10), failed_since timestamptz,
  CHECK ((consecutive=0)=(failed_since IS NULL)), CHECK (failed_since IS NULL OR failed_since<=checked_at)
);
CREATE TABLE creator_auto_check_incidents (
  incident_id uuid PRIMARY KEY,
  client_id text NOT NULL CHECK (client_id IN ('punpan_020','srihiw','nnshop5719','ashopbytheta','myushop4','bubpa_shop189','koolkool888')),
  session_id uuid NOT NULL, failed_since timestamptz NOT NULL, detected_at timestamptz NOT NULL, accepted_at timestamptz,
  UNIQUE (client_id,session_id,failed_since), CHECK (detected_at>=failed_since),
  CHECK (accepted_at IS NULL OR accepted_at>=detected_at)
);
CREATE INDEX creator_auto_check_incidents_pending ON creator_auto_check_incidents
  (client_id,session_id,detected_at,incident_id) WHERE accepted_at IS NULL;
`;
const MS = 60_000;
const dbs: PGlite[] = [];
afterEach(async () => { for (const db of dbs.splice(0)) await db.close(); });

async function fixture({ legacy = false }: { legacy?: boolean } = {}) {
  const db = new PGlite(); dbs.push(db);
  const statements: string[] = [];
  const database = { createQueryRunner: () => ({ connect: async () => undefined, release: async () => undefined,
    query: async (sql: string, args?: unknown[]) => {
      statements.push(sql);
      if (sql.includes("CREATE TABLE")) { await db.exec(sql); return []; }
      const result = await db.query(sql, args);
      return sql.trimStart().startsWith("UPDATE") ? [result.rows, result.affectedRows ?? 0] : result.rows;
    } }) };
  for (const name of Object.values(sessionTables)) await db.exec(`CREATE TABLE ${name} (
    session_id uuid PRIMARY KEY,client_id text NOT NULL,created_order bigint GENERATED ALWAYS AS IDENTITY,
    authorized_at timestamptz NOT NULL,status text NOT NULL,keep_auto_across_rooms boolean NOT NULL)`);
  const start = Date.now() - 40 * MS, iso = (n: number) => new Date(n).toISOString();
  const store = createCreatorAutoCheckHealthStore(database);
  if (legacy) await db.exec(LEGACY_SCHEMA);
  else await store.ensureSchema();
  const activate = async (scope: keyof typeof sessionTables = P, { persistent = true, status = "ACTIVE", authorizedAt = start - MS }: {
    persistent?: boolean; status?: string; authorizedAt?: number;
  } = {}) => {
    const id = randomUUID();
    await db.query(`INSERT INTO ${sessionTables[scope]} (session_id,client_id,authorized_at,status,keep_auto_across_rooms)
      VALUES ($1,$2,$3,$4,$5)`, [id, scope, iso(authorizedAt), status, persistent]);
    return id;
  };
  const event = (sessionId: string, at: number, outcome: CreatorAutoCheckOutcome = "CHECK_FAILED") => ({ sessionId, checkedAt: iso(at), outcome });
  async function series(sessionId: string, first = start, count = 10, scope: keyof typeof sessionTables = P) {
    for (let i = 0; i < count; i++) await store.record(scope, event(sessionId, first + i * MS));
  }
  const state = async (scope: keyof typeof sessionTables = P) => (await db.query<{ consecutive: number }>(
    "SELECT consecutive FROM creator_auto_check_health WHERE client_id=$1", [scope])).rows[0]?.consecutive;
  const incidents = async () => (await db.query<{ accepted_at: Date | null }>(
    "SELECT accepted_at FROM creator_auto_check_incidents ORDER BY detected_at,incident_id")).rows;
  const snapshot = async () => ({
    health: (await db.query("SELECT * FROM creator_auto_check_health ORDER BY client_id")).rows,
    incidents: (await db.query("SELECT * FROM creator_auto_check_incidents ORDER BY client_id,detected_at,incident_id")).rows,
  });
  const checks = async () => (await db.query(`SELECT t.relname,c.conname,c.convalidated,pg_get_expr(c.conbin,c.conrelid) AS expression
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    WHERE c.conrelid IN ('creator_auto_check_health'::regclass,'creator_auto_check_incidents'::regclass) AND c.contype='c'
    ORDER BY t.relname,c.conname`)).rows;
  return { db, database, store, activate, series, state, incidents, event, start, iso, statements, snapshot, checks };
}

describe("durable Creator Auto check failures", () => {
  it("creates all eight exact scopes and retains distinct stable alert identities", async () => {
    const f = await fixture();
    await f.store.ensureSchema();
    const byScope = new Map<ContinuousCreatorBudgetScope, NonNullable<Awaited<ReturnType<typeof f.store.pending>>>>();
    for (const scope of allScopes) {
      const sessionId = await f.activate(scope);
      await f.series(sessionId, f.start, 10, scope);
      expect(await f.state(scope)).toBe(10);
      const pending = (await f.store.pending(scope))!;
      expect(pending).toMatchObject({ sessionId, failedSince: f.iso(f.start), detectedAt: f.iso(f.start + 9 * MS) });
      for (const [otherScope, otherIncident] of byScope) {
        expect(await f.store.markDelivered(scope, otherIncident)).toBe(false);
        expect(await f.store.markDelivered(otherScope, pending)).toBe(false);
      }
      byScope.set(scope, pending);
    }
    expect(new Set([...byScope.values()].map(({ incidentId }) => incidentId)).size).toBe(8);
    expect(await f.incidents()).toHaveLength(8);
    for (const [scope, pending] of byScope) expect(await f.store.markDelivered(scope, pending)).toBe(true);
    expect((await f.incidents()).every(row => row.accepted_at !== null)).toBe(true);
  }, 30_000);

  it("widens the literal seven-scope schema in place without changing streaks or accepted and pending retry identities", async () => {
    const f = await fixture({ legacy: true });
    const pending = new Map<ContinuousCreatorBudgetScope, NonNullable<Awaited<ReturnType<typeof f.store.pending>>>>();
    for (const [index, scope] of oldScopes.entries()) {
      const id = await f.activate(scope);
      await f.series(id, f.start, scope === P ? 9 : 10, scope);
      const alert = await f.store.pending(scope);
      if (alert) {
        pending.set(scope, alert);
        if (index % 2 === 1) expect(await f.store.markDelivered(scope, alert)).toBe(true);
      }
    }
    const before = await f.snapshot(), oldChecks = await f.checks();
    expect(before.health).toHaveLength(7);
    expect(before.incidents).toHaveLength(6);
    expect(before.incidents.some(row => row.accepted_at !== null)).toBe(true);
    expect(before.incidents.some(row => row.accepted_at === null)).toBe(true);
    const indexBefore = (await f.db.query("SELECT oid FROM pg_class WHERE relname='creator_auto_check_incidents_pending'")).rows;
    await f.store.ensureSchema();
    const upgradedChecks = await f.checks();
    await f.store.ensureSchema();
    expect(await f.snapshot()).toEqual(before);
    expect(await f.checks()).toEqual(upgradedChecks);
    expect((await f.db.query("SELECT oid FROM pg_class WHERE relname='creator_auto_check_incidents_pending'")).rows).toEqual(indexBefore);
    expect(upgradedChecks.filter(row => String(row.conname).endsWith("_scope_v2"))).toHaveLength(2);
    expect(upgradedChecks.filter(row => !String(row.conname).endsWith("_scope_v2")))
      .toEqual(oldChecks.filter(row => row.conname !== "creator_auto_check_health_client_id_check" && row.conname !== "creator_auto_check_incidents_client_id_check"));
    for (const [scope, alert] of pending) {
      const accepted = before.incidents.find(row => row.incident_id === alert.incidentId)?.accepted_at;
      expect(await f.store.pending(scope)).toEqual(accepted ? null : alert);
      // The immutable incident ID is the cross-service idempotency identity;
      // the migration does not create a new downstream retry key or notice.
      expect((await f.snapshot()).incidents.some(row => row.incident_id === alert.incidentId)).toBe(true);
    }
    const oldSession = (before.health.find(row => row.client_id === P)!.session_id) as string;
    await f.store.record(P, f.event(oldSession, f.start + 9 * MS));
    expect(await f.state(P)).toBe(10);
    expect(await f.store.pending(P)).toMatchObject({ sessionId: oldSession, failedSince: f.iso(f.start) });
    const boomkan = await f.activate("boomkan");
    await f.series(boomkan, f.start, 10, "boomkan");
    expect(await f.store.pending("boomkan")).toMatchObject({ sessionId: boomkan });
  }, 30_000);

  it("rolls back both tables when the second legacy scope guard is unexpected", async () => {
    const f = await fixture({ legacy: true }), s = await f.activate();
    await f.series(s);
    const pending = (await f.store.pending(P))!;
    await f.db.exec(`ALTER TABLE creator_auto_check_incidents DROP CONSTRAINT creator_auto_check_incidents_client_id_check;
      ALTER TABLE creator_auto_check_incidents ADD CONSTRAINT unfamiliar_scope CHECK (client_id IN ('punpan_020','srihiw'));`);
    const before = await f.snapshot(), checksBefore = await f.checks();
    await expect(f.store.ensureSchema()).rejects.toThrow("CREATOR_AUTO_CHECK_HEALTH_UNAVAILABLE");
    expect(f.statements.at(-1)).toBe("ROLLBACK");
    expect(await f.snapshot()).toEqual(before);
    expect(await f.checks()).toEqual(checksBefore);
    expect(await f.store.pending(P)).toEqual(pending);
    const boomkan = await f.activate("boomkan");
    await expect(f.store.record("boomkan", f.event(boomkan, f.start))).rejects.toThrow("CREATOR_AUTO_CHECK_HEALTH_UNAVAILABLE");
    expect(await f.state("boomkan")).toBeUndefined();
  });

  it("does not accept a correct current guard that masks an additional client-ID restriction", async () => {
    const f = await fixture();
    await f.db.exec("ALTER TABLE creator_auto_check_health ADD CONSTRAINT unexpected_exclusion CHECK (client_id <> 'boomkan') NOT VALID");
    const before = await f.checks();
    await expect(f.store.ensureSchema()).rejects.toThrow("CREATOR_AUTO_CHECK_HEALTH_UNAVAILABLE");
    expect(await f.checks()).toEqual(before);
  });

  it("rejects tampered versioned guards and preserves the original transaction state", async () => {
    const f = await fixture();
    await f.db.exec(`ALTER TABLE creator_auto_check_incidents DROP CONSTRAINT creator_auto_check_incidents_scope_v2;
      ALTER TABLE creator_auto_check_incidents ADD CONSTRAINT creator_auto_check_incidents_scope_v2 CHECK (client_id <> 'other');`);
    const before = await f.checks();
    await expect(f.store.ensureSchema()).rejects.toThrow("CREATOR_AUTO_CHECK_HEALTH_UNAVAILABLE");
    expect(await f.checks()).toEqual(before);
  });

  it("counts ten genuine polls, deduplicates an entire streak and retries the same incident across restart", async () => {
    const f = await fixture(), s = await f.activate();
    await f.series(s, f.start, 9);
    expect(await f.state()).toBe(9);
    expect(await f.store.pending(P)).toBeNull();
    const restarted = createCreatorAutoCheckHealthStore(f.database);
    await restarted.ensureSchema();
    await restarted.record(P, f.event(s, f.start + 9 * MS));
    const pending = (await restarted.pending(P))!;
    expect(pending).toEqual({ sessionId: s, incidentId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      failedSince: f.iso(f.start), detectedAt: f.iso(f.start + 9 * MS) });
    await f.series(s, f.start + 9 * MS, 4);
    expect(await f.state()).toBe(10);
    expect(await f.store.pending(P)).toEqual(pending);
    expect(await f.incidents()).toHaveLength(1);
    expect(await restarted.markDelivered(P, { ...pending, incidentId: randomUUID() })).toBe(false);
    expect(await restarted.markDelivered(P, pending)).toBe(true);
    expect(await f.store.markDelivered(P, pending)).toBe(true); // Lost response retry.
    expect(await f.store.pending(P)).toBeNull();
    await f.store.record(P, f.event(s, f.start + 13 * MS));
    expect(await f.incidents()).toHaveLength(1);
  });

  it("does not count repeat, out-of-order, too-fast, future or missed ticks as consecutive", async () => {
    const f = await fixture(), s = await f.activate();
    await f.store.record(P, f.event(s, f.start - MS - 1)); // Before authorization.
    await f.store.record(P, f.event(s, Date.now() + 120_000));
    expect(await f.state()).toBeUndefined();
    await f.series(s, f.start, 9);
    await f.store.record(P, f.event(s, f.start + 8 * MS));
    await f.store.record(P, f.event(s, f.start + 8 * MS + 39_999));
    await f.store.record(P, f.event(s, f.start + 7 * MS, "CHECK_VERIFIED"));
    expect(await f.state()).toBe(9);
    expect(await f.store.pending(P)).toBeNull();
    await f.store.record(P, f.event(s, f.start + 8 * MS + 110_001));
    expect(await f.state()).toBe(1);
    expect(await f.store.pending(P)).toBeNull();
    await f.store.record(P, f.event(s, f.start + 8 * MS + 150_001));
    expect(await f.state()).toBe(2); // Exactly 40s counts; earlier duplicate did not move the clock.
  });

  it("does not create a second alert after a long gap in an already-detected outage", async () => {
    const f = await fixture(), s = await f.activate();
    await f.series(s);
    const first = (await f.store.pending(P))!;
    const restarted = createCreatorAutoCheckHealthStore(f.database);
    await restarted.record(P, f.event(s, f.start + 13 * MS));
    expect(await restarted.pending(P)).toEqual(first);
    expect(await f.state()).toBe(10);
    expect(await restarted.markDelivered(P, first)).toBe(true);
    await f.series(s, f.start + 17 * MS);
    expect(await restarted.pending(P)).toBeNull();
    expect(await f.state()).toBe(10);
    expect(await f.incidents()).toHaveLength(1);
  });

  it("breaks streaks on verified results and normal holds while preserving prior undelivered incidents", async () => {
    const f = await fixture(), s = await f.activate();
    await f.series(s, f.start, 9);
    await f.store.record(P, f.event(s, f.start + 9 * MS, "NORMAL_HOLD"));
    expect(await f.state()).toBe(0);
    await f.series(s, f.start + 10 * MS);
    const first = (await f.store.pending(P))!;
    await f.store.record(P, f.event(s, f.start + 20 * MS, "CHECK_VERIFIED"));
    expect(await f.state()).toBe(0);
    expect(await f.store.pending(P)).toEqual(first);
    await f.series(s, f.start + 21 * MS);
    expect(await f.incidents()).toHaveLength(2);
    expect(await f.store.pending(P)).toEqual(first);
    expect(await f.store.markDelivered(P, first)).toBe(true);
    const second = (await f.store.pending(P))!;
    expect(second.incidentId).not.toBe(first.incidentId);
    expect(second.failedSince).toBe(f.iso(f.start + 21 * MS));
  });

  it("uses only the exact latest armed scope/session and never delivers after stop or replacement", async () => {
    const f = await fixture(), p = await f.activate(), sri = await f.activate(S);
    await f.series(p, f.start, 10, S); // Valid UUID, wrong account.
    expect(await f.state(S)).toBeUndefined();
    await f.series(sri, f.start, 10, S);
    expect(await f.store.pending(P)).toBeNull();
    const sriIncident = (await f.store.pending(S))!;
    expect(await f.store.markDelivered(P, sriIncident)).toBe(false);
    await f.series(p);
    const old = (await f.store.pending(P))!;
    await f.db.query(`UPDATE ${sessionTables[P]} SET status='STOPPED' WHERE session_id=$1`, [p]);
    expect(await f.store.pending(P)).toBeNull();
    expect(await f.store.markDelivered(P, old)).toBe(false);
    const replacement = await f.activate();
    await f.store.record(P, f.event(p, f.start + 10 * MS));
    expect(await f.store.pending(P)).toBeNull();
    await f.store.record(P, f.event(replacement, f.start + 10 * MS));
    expect(await f.state()).toBe(1);
    expect(await f.store.pending(S)).toEqual(sriIncident);
    const legacy = await f.activate(P, { persistent: false });
    await f.series(legacy, f.start + 11 * MS);
    expect(await f.state()).toBe(1);
    expect(await f.store.pending(P)).toBeNull();
  });

  it("expires unaccepted alerts locally without removing their audit record", async () => {
    const f = await fixture(), historic = f.start - 25 * 60 * MS;
    const s = await f.activate(P, { authorizedAt: historic - MS });
    await f.series(s, historic);
    expect(await f.store.pending(P)).toBeNull();
    expect(await f.incidents()).toHaveLength(1);
    const row = (await f.db.query<{ incident_id: string }>("SELECT incident_id FROM creator_auto_check_incidents")).rows[0];
    expect(await f.store.markDelivered(P, { sessionId: s, incidentId: row.incident_id })).toBe(false);
    await f.store.record(P, f.event(s, f.start - 2 * MS));
    expect(await f.store.pending(P)).toBeNull(); // Expiry is not recovery.
    await f.store.record(P, f.event(s, f.start - MS, "CHECK_VERIFIED"));
    await f.series(s, f.start);
    expect(await f.store.pending(P)).toMatchObject({ sessionId: s, failedSince: f.iso(f.start) });
    expect(await f.incidents()).toHaveLength(2);
  });

  it("rejects malformed or non-canonical input before storage", async () => {
    const f = await fixture(), s = await f.activate();
    await expect(f.store.record(P, { ...f.event(s, f.start), checkedAt: "2026-11-10T08:00:00+00:00" })).rejects.toThrow("INPUT");
    await expect(f.store.record("__proto__" as ContinuousCreatorBudgetScope, f.event(s, f.start))).rejects.toThrow("INPUT");
    await expect(f.store.markDelivered(P, { sessionId: s, incidentId: "bogus" })).rejects.toThrow("INPUT");
    expect(await f.state()).toBeUndefined();
  });
});
