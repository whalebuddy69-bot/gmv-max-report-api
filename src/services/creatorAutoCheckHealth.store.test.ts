import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { createCreatorAutoCheckHealthStore, type CreatorAutoCheckOutcome } from "./creatorAutoCheckHealth.store";
import type { ContinuousCreatorBudgetScope } from "./creatorBudgetScope";

const P = "punpan_020", S = "srihiw";
const sessionTables = { [P]: "creator_continuous_auto_budget_sessions", [S]: "creator_srihiw_continuous_auto_budget_sessions" } as const;
const MS = 60_000;
const dbs: PGlite[] = [];
afterEach(async () => { for (const db of dbs.splice(0)) await db.close(); });

async function fixture() {
  const db = new PGlite(); dbs.push(db);
  const database = { createQueryRunner: () => ({ connect: async () => undefined, release: async () => undefined,
    query: async (sql: string, args?: unknown[]) => {
      if (sql.includes("CREATE TABLE")) { await db.exec(sql); return []; }
      const result = await db.query(sql, args);
      return sql.trimStart().startsWith("UPDATE") ? [result.rows, result.affectedRows ?? 0] : result.rows;
    } }) };
  for (const name of Object.values(sessionTables)) await db.exec(`CREATE TABLE ${name} (
    session_id uuid PRIMARY KEY,client_id text NOT NULL,created_order bigint GENERATED ALWAYS AS IDENTITY,
    authorized_at timestamptz NOT NULL,status text NOT NULL,keep_auto_across_rooms boolean NOT NULL)`);
  const start = Date.now() - 40 * MS, iso = (n: number) => new Date(n).toISOString();
  const store = createCreatorAutoCheckHealthStore(database);
  await store.ensureSchema();
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
  return { db, database, store, activate, series, state, incidents, event, start, iso };
}

describe("durable Creator Auto check failures", () => {
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
