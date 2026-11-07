import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { createCreatorWebBudgetStore } from "./creatorWebBudget.store";
import { WebBudgetProposal } from "./creatorWebBudget.service";

const dbs: PGlite[] = [];
afterEach(async () => { for (const db of dbs.splice(0)) await db.close(); });
function setup() {
  const db = new PGlite(); dbs.push(db);
  const events: string[] = [];
  const database = { createQueryRunner: () => ({ connect: async () => undefined, release: async () => undefined,
    query: async (sql: string, params?: unknown[]) => {
      events.push(sql);
      if (sql.includes("CREATE TABLE")) { await db.exec(sql); return []; }
      const result = await db.query(sql, params);
      return sql.trimStart().startsWith("UPDATE") ? [result.rows, result.affectedRows ?? 0] : result.rows;
    } }) };
  return { db, events, database, store: createCreatorWebBudgetStore(database) };
}
function proposal(mode: WebBudgetProposal["mode"] = "live", ownerId = 27): WebBudgetProposal {
  return { operationId: randomUUID(), ownerId, mode, campaignId: "90000000000001", reportingDate: "2026-06-09",
    currentBudgetMinor: 120000, targetBudgetMinor: 150000, projectedClientSpendMinor: 270000,
    cap: { revision: 3, campaignCapMinor: 600000, clientDailyCapMinor: 800000, locked: false, readAt: new Date().toISOString() },
    fingerprint: "a".repeat(64), expiresAt: new Date(Date.now() + 120000).toISOString() };
}

describe("Postgres budget operation ledger", () => {
  it("requires explicit additive bootstrap and reserves only the owner/unexpired/mode-matched operation", async () => {
    const h = setup(), row = proposal();
    await expect(h.store.get(row.ownerId, row.operationId)).rejects.toMatchObject({ code: "BUDGET_LEDGER_UNAVAILABLE" });
    expect(h.events.some(sql => /CREATE TABLE/.test(sql))).toBe(false);
    await h.store.ensureSchema(); await h.store.ensureSchema();
    await h.store.create(row);
    expect(await h.store.get(row.ownerId + 1, row.operationId)).toBeNull();
    expect(await h.store.reserve(row.ownerId + 1, row.operationId, "live")).toBeNull();
    expect(await h.store.reserve(row.ownerId, row.operationId, "dry-run")).toBeNull();
    expect(await h.store.reserve(row.ownerId, row.operationId, "live")).toMatchObject({ ...row, status: "PROCESSING" });
    expect(h.events.at(-1)).toBe("COMMIT");
    const restored = createCreatorWebBudgetStore(h.database);
    expect(await restored.reserve(row.ownerId, row.operationId, "live")).toBeNull();
    expect(await restored.get(row.ownerId, row.operationId)).toMatchObject({ status: "PROCESSING" });
  });

  it("fences across owners and processes, keeps UNKNOWN indefinitely, never downgrades terminal proof", async () => {
    const h = setup(); await h.store.ensureSchema();
    const one = proposal(), two = proposal("live", 42), three = proposal();
    for (const row of [one, two, three]) await h.store.create(row);
    await h.store.reserve(one.ownerId, one.operationId, "live");
    expect(await h.store.reserve(two.ownerId, two.operationId, "live")).toBeNull();
    expect(await h.store.finish(one.ownerId, one.operationId, { status: "APPLIED_VERIFIED", observedBudgetMinor: 150000, reason: "VERIFIED" }))
      .toMatchObject({ status: "APPLIED_VERIFIED", observedBudgetMinor: 150000 });
    expect(await h.store.finish(one.ownerId, one.operationId, { status: "OUTCOME_UNKNOWN", observedBudgetMinor: null, reason: "STALE_FAILURE" }))
      .toMatchObject({ status: "APPLIED_VERIFIED", observedBudgetMinor: 150000 });
    await h.store.reserve(two.ownerId, two.operationId, "live");
    await h.store.finish(two.ownerId, two.operationId, { status: "OUTCOME_UNKNOWN", observedBudgetMinor: null, reason: "READBACK_UNVERIFIED" });
    await h.db.query("UPDATE creator_web_budget_operations SET expires_at = clock_timestamp() - interval '1 day' WHERE operation_id=$1", [two.operationId]);
    expect(await h.store.hasFence()).toBe(true);
    expect(await h.store.reserve(three.ownerId, three.operationId, "live")).toBeNull();
  });

  it("releases only expired simulation fences and does not replay an expired proposal", async () => {
    const h = setup(); await h.store.ensureSchema();
    const sim = proposal("dry-run"), newOp = proposal("dry-run");
    await h.store.create(sim); await h.store.create(newOp);
    await h.store.reserve(sim.ownerId, sim.operationId, "dry-run");
    await h.db.query("UPDATE creator_web_budget_operations SET expires_at = clock_timestamp() - interval '1 second' WHERE operation_id=$1", [sim.operationId]);
    expect(await h.store.hasFence()).toBe(false);
    expect(await h.store.reserve(sim.ownerId, sim.operationId, "dry-run")).toBeNull();
    expect(await h.store.reserve(newOp.ownerId, newOp.operationId, "dry-run")).toMatchObject({ status: "PROCESSING" });
    expect(await h.store.get(sim.ownerId, sim.operationId)).toMatchObject({ status: "NOT_SENT", observedBudgetMinor: null });
  });
});
