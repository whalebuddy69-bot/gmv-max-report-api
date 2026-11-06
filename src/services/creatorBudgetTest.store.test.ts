import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { CREATOR_BINDING } from "./creatorRead.service";
import { CreatorBudgetTestPermit, creatorBudgetTestFingerprint } from "./creatorBudgetTest.service";
import { createCreatorBudgetTestStore } from "./creatorBudgetTest.store";

const databases: PGlite[] = [];
afterEach(async () => { for (const db of databases.splice(0)) await db.close(); });
const permit: CreatorBudgetTestPermit = { permitId: "ppan-sql-one-shot-20261108", clientId: "punpan_020", binding: { ...CREATOR_BINDING },
  campaignId: "1881130110195874", expectedBudgetMinor: 300000, targetBudgetMinor: 360000, capMinor: 1000000,
  policyRevision: 1, localDate: "2026-11-08", notBefore: "2026-11-07T23:00:00Z", expiresAt: "2026-11-08T05:00:00Z",
  nativeAutoBudgetVerifiedOff: true, exclusiveWriterConfirmed: true };
function setup() {
  const db = new PGlite(); databases.push(db);
  const events: string[] = [];
  const database = { createQueryRunner: () => ({ connect: async () => {}, release: async () => {},
    query: async (sql: string, params?: any[]) => {
      events.push(sql); const result = await db.query(sql, params);
      // Match the installed TypeORM/Postgres driver's UPDATE result shape.
      return sql.trimStart().startsWith("UPDATE") ? [result.rows, result.affectedRows ?? 0] : result.rows;
    } }) };
  return { db, events, store: createCreatorBudgetTestStore(database), database };
}
describe("durable PostgreSQL one-shot fence", () => {
  it("is additive and leaves a missing schema unavailable until explicit bootstrap", async () => {
    const h = setup();
    await expect(h.store.get(permit.permitId)).rejects.toMatchObject({ code: "BUDGET_TEST_LEDGER_UNAVAILABLE" });
    expect(h.events.some(sql => /CREATE|INSERT|UPDATE|DELETE/.test(sql))).toBe(false);
    await h.store.ensureSchema(); await h.store.ensureSchema();
    expect(await h.store.get(permit.permitId)).toBeNull();
  });
  it("commits reservation before returning, survives a new store instance, and blocks a second permit that day", async () => {
    const h = setup(); await h.store.ensureSchema();
    const hash = creatorBudgetTestFingerprint(permit), reservation = await h.store.reserve(permit, hash, { modifyTime: "test-baseline" });
    expect(reservation).toMatchObject({ created: true, operation: { status: "SEND_RESERVED", postCount: 1, providerAccepted: null } });
    expect(h.events.at(-1)).toBe("COMMIT");
    const restarted = createCreatorBudgetTestStore(h.database);
    expect(await restarted.reserve(permit, hash, {})).toMatchObject({ created: false, operation: { status: "SEND_RESERVED", postCount: 1 } });
    const other = { ...permit, permitId: "ppan-second-permit-same-day" };
    await expect(restarted.reserve(other, creatorBudgetTestFingerprint(other), {})).rejects.toMatchObject({ code: "DAY_TEST_ALREADY_RESERVED" });
    expect((await h.db.query("SELECT * FROM creator_budget_test_operations")).rows).toHaveLength(1);
  });
  it("preserves proven terminal results against stale concurrent reconciliation and never clears a fence", async () => {
    const h = setup(); await h.store.ensureSchema(); const hash = creatorBudgetTestFingerprint(permit);
    await h.store.reserve(permit, hash, {});
    await h.store.finish(permit.permitId, hash, { status: "SUCCEEDED", providerAccepted: true, observedBudgetMinor: 360000, reason: "PROVIDER_ACCEPTED_AND_READBACK_MATCHED" });
    expect(await h.store.finish(permit.permitId, hash, { status: "OUTCOME_UNKNOWN", providerAccepted: null, observedBudgetMinor: 300000, reason: "STALE_READ" }))
      .toMatchObject({ status: "SUCCEEDED", providerAccepted: true, observedBudgetMinor: 360000, postCount: 1 });
    expect(h.events.some(sql => /DELETE|TRUNCATE|DROP|ALTER TABLE/.test(sql))).toBe(false);
  });
});
