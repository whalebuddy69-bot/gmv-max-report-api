import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCreatorContinuousAutoBudgetStore, type CreatorContinuousAutoBudgetArmInput,
  type CreatorContinuousAutoBudgetSession,
} from "./creatorContinuousAutoBudget.store";
import { createCreatorWebBudgetStore } from "./creatorWebBudget.store";
import type { WebBudgetProposal } from "./creatorWebBudget.service";

const CAMPAIGN = "12000000000001";
const ROOM = "12000000000002";
const BEFORE = "a".repeat(64);
const AFTER = "b".repeat(64);
const NEXT = "c".repeat(64);
const dbs: PGlite[] = [];
afterEach(async () => { for (const db of dbs.splice(0)) await db.close(); });

function setup() {
  const db = new PGlite(); dbs.push(db);
  const statements: string[] = [];
  const database = { createQueryRunner: () => ({ connect: async () => undefined, release: async () => undefined,
    query: async (sql: string, params?: unknown[]) => {
      statements.push(sql);
      if (sql.includes("CREATE TABLE")) { await db.exec(sql); return []; }
      const result = await db.query(sql, params);
      return sql.trimStart().startsWith("UPDATE") ? [result.rows, result.affectedRows ?? 0] : result.rows;
    } }) };
  return { db, statements, database, sessions: createCreatorContinuousAutoBudgetStore(database), web: createCreatorWebBudgetStore(database) };
}
function arm(overrides: Partial<CreatorContinuousAutoBudgetArmInput> = {}): CreatorContinuousAutoBudgetArmInput {
  return { sessionId: randomUUID(), ownerId: 17, campaignId: CAMPAIGN, liveSessionId: ROOM, policyRevision: 2,
    baselineBudgetMinor: 650_001, baselineFingerprint: BEFORE, nativeAutoOffAttested: true, noConcurrentChangesAttested: true, ...overrides };
}
function operation(session: CreatorContinuousAutoBudgetSession, target = Number(BigInt(session.baselineBudgetMinor) * 6n / 5n),
  overrides: Partial<WebBudgetProposal> = {}): WebBudgetProposal {
  const now = Date.now();
  return { operationId: randomUUID(), mode: "live", source: "auto", ownerId: session.ownerId, campaignId: session.campaignId,
    reportingDate: "2026-11-08", currentBudgetMinor: session.baselineBudgetMinor, targetBudgetMinor: target,
    projectedClientSpendMinor: target + 5000, cap: { revision: session.policyRevision,
      campaignCapMinor: 4_000_000, clientDailyCapMinor: 4_000_000, locked: false, readAt: new Date(now).toISOString() },
    fingerprint: session.baselineFingerprint, expiresAt: new Date(now + 120_000).toISOString(), ...overrides };
}

describe("Ppan continuous Auto session", () => {
  it("bootstraps only explicitly, permits only one open exact session, and does not expire it by elapsed time", async () => {
    const h = setup();
    await expect(h.sessions.getActive()).rejects.toThrow("CREATOR_CONTINUOUS_AUTO_STORE_UNAVAILABLE");
    expect(h.statements.some(sql => sql.includes("CREATE TABLE"))).toBe(false);
    await h.sessions.ensureSchema(); await h.sessions.ensureSchema();
    expect(await h.sessions.getLatest()).toBeNull();
    expect(await h.sessions.arm(arm({ liveSessionId: "bad" }))).toBeNull();
    expect(await h.sessions.arm(arm({ noConcurrentChangesAttested: false as true }))).toBeNull();
    const draft = arm(), saved = await h.sessions.arm(draft);
    expect(saved).toMatchObject({ ...draft, clientId: "punpan_020", status: "ACTIVE",
      operationId: null, lastVerifiedAt: null, stopReason: null });
    const other = createCreatorContinuousAutoBudgetStore(h.database);
    expect(await other.arm(arm({ ownerId: 23 }))).toBeNull();
    await expect(h.db.query("UPDATE creator_continuous_auto_budget_sessions SET client_id='srihiw' WHERE session_id=$1", [draft.sessionId]))
      .rejects.toMatchObject({ code: "23514" });
    await h.db.query("UPDATE creator_continuous_auto_budget_sessions SET authorized_at=clock_timestamp()-interval '30 days' WHERE session_id=$1", [draft.sessionId]);
    expect(await other.getActive()).toMatchObject({ sessionId: draft.sessionId, status: "ACTIVE" });
    expect(await other.stop(23, draft.sessionId)).toBeNull();
    expect(await other.stop(draft.ownerId, draft.sessionId, "LIVE_ENDED"))
      .toMatchObject({ status: "STOPPED", operationId: null, stopReason: "LIVE_ENDED" });
    expect(await other.getActive()).toBeNull();
    expect(await other.getLatest()).toMatchObject({ sessionId: draft.sessionId, status: "STOPPED" });
  });

  it("binds one immutable attempt to the exact live Auto ledger and advances only after exact verified readback", async () => {
    const h = setup(); await h.web.ensureSchema(); await h.sessions.ensureSchema();
    const s = (await h.sessions.arm(arm()))!, other = createCreatorContinuousAutoBudgetStore(h.database);
    const first = operation(s), another = operation(s), manual = operation(s, first.targetBudgetMinor, { source: "manual" });
    await h.web.create(first); await h.web.create(another); await h.web.create(manual);
    expect(first.targetBudgetMinor).toBe(780_001);
    expect(await h.sessions.reserve(s, manual.operationId, first.targetBudgetMinor)).toBeNull();
    expect(await h.sessions.reserve(s, first.operationId, first.targetBudgetMinor + 1)).toBeNull();
    expect(await h.sessions.reserve({ ...s, liveSessionId: "12000000000003" }, first.operationId, first.targetBudgetMinor)).toBeNull();
    expect(await h.sessions.reserve({ ...s, policyRevision: 9 }, first.operationId, first.targetBudgetMinor)).toBeNull();
    expect(await h.sessions.reserve(s, first.operationId, first.targetBudgetMinor))
      .toMatchObject({ operationId: first.operationId, status: "ACTIVE" });
    expect(h.statements.at(-1)).toBe("COMMIT");
    expect(await other.reserve(s, another.operationId, another.targetBudgetMinor)).toBeNull();
    expect(await other.isReserved(s, another.operationId)).toBe(false);
    expect(await other.isReserved(s, first.operationId)).toBe(true);
    const verified = { budgetMinor: first.targetBudgetMinor, fingerprint: AFTER };
    expect(await other.settleVerified(s, first.operationId, verified)).toBeNull();
    await h.web.reserve(s.ownerId, first.operationId, "live");
    await h.web.finish(s.ownerId, first.operationId, { status: "APPLIED_VERIFIED", observedBudgetMinor: first.targetBudgetMinor,
      observedFingerprint: AFTER, reason: "VERIFIED" });
    expect(await other.settleVerified(s, first.operationId, { ...verified, fingerprint: BEFORE })).toBeNull();
    expect(await other.settleVerified(s, first.operationId, { ...verified, fingerprint: NEXT })).toBeNull();
    expect(await other.getActive()).toMatchObject({ status: "ACTIVE", operationId: first.operationId, baselineFingerprint: BEFORE });
    const next = (await other.settleVerified(s, first.operationId, verified))!;
    expect(next).toMatchObject({ status: "ACTIVE", operationId: null, baselineBudgetMinor: 780_001,
      baselineFingerprint: AFTER, lastOutcome: "APPLIED_VERIFIED", lastVerifiedAt: expect.any(String) });
    expect(await h.sessions.isReserved(s, first.operationId)).toBe(false);
    expect(await h.sessions.reserve(s, another.operationId, another.targetBudgetMinor)).toBeNull();
    const nextOp = operation(next);
    await h.web.create(nextOp);
    expect(await h.sessions.reserve(next, nextOp.operationId, nextOp.targetBudgetMinor)).toMatchObject({ operationId: nextOp.operationId });
    expect((await h.db.query("SELECT operation_id FROM creator_continuous_auto_budget_attempts ORDER BY reserved_at")).rows)
      .toEqual([{ operation_id: first.operationId }, { operation_id: nextOp.operationId }]);
  });

  it("locks an uncertain outcome indefinitely and Stop never erases the reservation", async () => {
    const h = setup(); await h.web.ensureSchema(); await h.sessions.ensureSchema();
    const s = (await h.sessions.arm(arm()))!, op = operation(s);
    await h.web.create(op); await h.sessions.reserve(s, op.operationId, op.targetBudgetMinor);
    await h.web.reserve(s.ownerId, op.operationId, "live");
    await h.web.finish(s.ownerId, op.operationId, { status: "OUTCOME_UNKNOWN", observedBudgetMinor: null, reason: "UNKNOWN" });
    expect(await h.sessions.markUnknown(s, op.operationId)).toMatchObject({ status: "BLOCKED", operationId: op.operationId, lastOutcome: "OUTCOME_UNKNOWN" });
    expect(await h.sessions.isReserved(s, op.operationId)).toBe(false);
    expect(await h.sessions.settleVerified(s, op.operationId, { budgetMinor: op.targetBudgetMinor, fingerprint: AFTER })).toBeNull();
    expect(await h.sessions.settleNotSent(s, op.operationId)).toBeNull();
    expect(await h.sessions.stop(s.ownerId, s.sessionId)).toMatchObject({ status: "STOPPED", operationId: op.operationId, stopReason: "OPERATOR_STOPPED" });
    expect(await h.sessions.getActive()).toMatchObject({ status: "STOPPED", operationId: op.operationId });
    expect(await h.sessions.arm(arm({ baselineFingerprint: AFTER }))).toBeNull();
  });

  it("allows verified reconciliation after Stop but never reactivates or replays the old fingerprint", async () => {
    const h = setup(); await h.web.ensureSchema(); await h.sessions.ensureSchema();
    const s = (await h.sessions.arm(arm()))!, op = operation(s);
    await h.web.create(op); await h.sessions.reserve(s, op.operationId, op.targetBudgetMinor);
    await h.web.reserve(s.ownerId, op.operationId, "live");
    await h.sessions.stop(s.ownerId, s.sessionId, "AUTHORITY_REVOKED");
    expect(await h.sessions.isReserved(s, op.operationId)).toBe(false);
    await h.web.finish(s.ownerId, op.operationId, { status: "APPLIED_VERIFIED", observedBudgetMinor: op.targetBudgetMinor,
      observedFingerprint: AFTER, reason: "VERIFIED" });
    expect(await h.sessions.settleVerified(s, op.operationId, { budgetMinor: op.targetBudgetMinor, fingerprint: AFTER }))
      .toMatchObject({ status: "STOPPED", operationId: null, stopReason: "AUTHORITY_REVOKED", lastOutcome: "APPLIED_VERIFIED" });
    expect(await h.sessions.getActive()).toBeNull();
    expect(await h.sessions.arm(arm())).toBeNull();
    expect(await h.sessions.arm(arm({ baselineBudgetMinor: op.targetBudgetMinor, baselineFingerprint: AFTER }))).toMatchObject({ status: "ACTIVE" });
  });

  it("only terminates a known never-sent operation, including a never-reserved proposal after its writer TTL", async () => {
    const h = setup(); await h.web.ensureSchema(); await h.sessions.ensureSchema();
    const first = (await h.sessions.arm(arm()))!, a = operation(first);
    await h.web.create(a); await h.sessions.reserve(first, a.operationId, a.targetBudgetMinor);
    expect(await h.sessions.settleNotSent(first, a.operationId)).toBeNull();
    await h.web.reserve(first.ownerId, a.operationId, "live");
    await h.web.finish(first.ownerId, a.operationId, { status: "NOT_SENT", observedBudgetMinor: null, reason: "PRECHECK" });
    expect(await h.sessions.settleNotSent(first, a.operationId)).toMatchObject({ status: "STOPPED", operationId: null, stopReason: "NOT_SENT" });
    expect(await h.sessions.arm(arm())).toBeNull();
    const second = (await h.sessions.arm(arm({ baselineFingerprint: NEXT })))!, b = operation(second);
    await h.web.create(b); await h.sessions.reserve(second, b.operationId, b.targetBudgetMinor);
    await h.db.query("UPDATE creator_web_budget_operations SET expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1", [b.operationId]);
    expect(await h.sessions.settleNotSent(second, b.operationId)).toMatchObject({ status: "STOPPED", lastOutcome: "NOT_SENT" });
  });
});
