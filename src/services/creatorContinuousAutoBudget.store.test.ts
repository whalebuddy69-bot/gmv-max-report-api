import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import {
  CREATOR_CONTINUOUS_AUTO_BUDGET_SCHEMA_SQL, CREATOR_CONTINUOUS_SPEND_TREND_SCHEMA_SQL,
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
function trendArm(overrides: Partial<CreatorContinuousAutoBudgetArmInput> = {}) {
  return arm({ evidenceMode: "spend-trend", liveSessionId: null, nativeAutoOffAttested: false,
    noConcurrentChangesAttested: false, ...overrides });
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
  it("keeps Srihiw session, attempts and writer proof independent, even with identical baseline data", async () => {
    const h = setup(), sri = createCreatorContinuousAutoBudgetStore(h.database, "srihiw"), sriWriter = createCreatorWebBudgetStore(h.database, "srihiw");
    await h.web.ensureSchema(); await sriWriter.ensureSchema(); await h.sessions.ensureSchema(); await sri.ensureSchema(); await sri.ensureSchema();
    expect(await sri.arm(arm())).toBeNull();
    const p = (await h.sessions.arm(trendArm({ baselineBudgetMinor: 85000 })))!;
    const s = (await sri.arm(trendArm({ baselineBudgetMinor: 85000 })))!;
    expect(s).toMatchObject({ clientId: "srihiw", status: "ACTIVE" });
    const pOp = operation(p), sOp = operation(s);
    await h.web.create(pOp); await sriWriter.create(sOp);
    expect(await sri.reserve(s, pOp.operationId, pOp.targetBudgetMinor)).toBeNull();
    expect(await h.sessions.reserve(p, sOp.operationId, sOp.targetBudgetMinor)).toBeNull();
    expect(await h.sessions.reserve(p, pOp.operationId, pOp.targetBudgetMinor)).toBeTruthy();
    expect(await sri.reserve(s, sOp.operationId, sOp.targetBudgetMinor)).toBeTruthy();
    expect(await sri.isReserved(p, pOp.operationId)).toBe(false);
    await sriWriter.reserve(s.ownerId, sOp.operationId, "live");
    await sriWriter.finish(s.ownerId, sOp.operationId, { status: "APPLIED_VERIFIED", observedBudgetMinor: sOp.targetBudgetMinor,
      observedFingerprint: AFTER, reason: "VERIFIED" });
    expect(await sri.settleVerified(s, sOp.operationId, { budgetMinor: sOp.targetBudgetMinor, fingerprint: AFTER })).toMatchObject({ baselineBudgetMinor: 102000 });
    expect(await h.sessions.getActive()).toMatchObject({ operationId: pOp.operationId, baselineBudgetMinor: 85000 });
  });
  it("bootstraps only explicitly, permits only one open exact session, and does not expire it by elapsed time", async () => {
    const h = setup();
    await expect(h.sessions.getActive()).rejects.toThrow("CREATOR_CONTINUOUS_AUTO_STORE_UNAVAILABLE");
    expect(h.statements.some(sql => sql.includes("CREATE TABLE"))).toBe(false);
    await h.sessions.ensureSchema(); await h.sessions.ensureSchema();
    expect(await h.sessions.getLatest()).toBeNull();
    expect(await h.sessions.arm(arm({ liveSessionId: "bad" }))).toBeNull();
    expect(await h.sessions.arm(arm({ noConcurrentChangesAttested: false }))).toBeNull();
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

  it("migrates exact legacy sessions and pending attempts without changing their authorization", async () => {
    const h = setup(); await h.web.ensureSchema();
    await h.db.exec(CREATOR_CONTINUOUS_AUTO_BUDGET_SCHEMA_SQL);
    const old = arm(), pendingId = randomUUID();
    await h.db.query(`INSERT INTO creator_continuous_auto_budget_sessions
      (session_id, client_id, owner_id, campaign_id, live_session_id, policy_revision, baseline_budget_minor,
        baseline_fingerprint, authorized_at, native_auto_off_attested, no_concurrent_changes_attested, operation_id)
      VALUES ($1,'punpan_020',$2,$3,$4,$5,$6,$7,date_trunc('milliseconds',clock_timestamp()),true,true,$8)`,
    [old.sessionId, old.ownerId, old.campaignId, old.liveSessionId, old.policyRevision, old.baselineBudgetMinor, old.baselineFingerprint, pendingId]);
    await h.db.query(`INSERT INTO creator_continuous_auto_budget_attempts
      (operation_id,session_id,client_id,campaign_id,live_session_id,baseline_fingerprint,baseline_budget_minor,target_budget_minor)
      VALUES ($1,$2,'punpan_020',$3,$4,$5,$6,$7)`, [pendingId, old.sessionId, old.campaignId, old.liveSessionId,
      old.baselineFingerprint, old.baselineBudgetMinor, 780_001]);
    await h.sessions.ensureSchema(); await h.sessions.ensureSchema();
    expect(await h.sessions.getActive()).toMatchObject({ ...old, evidenceMode: "verified-room", operationId: pendingId });
    expect((await h.db.query("SELECT live_session_id,evidence_mode FROM creator_continuous_auto_budget_attempts")).rows)
      .toEqual([{ live_session_id: ROOM, evidence_mode: "verified-room" }]);
    expect(await h.sessions.arm(trendArm({ baselineFingerprint: AFTER }))).toBeNull();
  });

  it("does not alter a nonstandard legacy authorization check", async () => {
    const h = setup();
    await h.db.exec(CREATOR_CONTINUOUS_AUTO_BUDGET_SCHEMA_SQL.replace("CHECK (native_auto_off_attested)",
      "CHECK (NOT native_auto_off_attested)"));
    await expect(h.sessions.ensureSchema()).rejects.toThrow("CREATOR_CONTINUOUS_AUTO_STORE_UNAVAILABLE");
    expect((await h.db.query(`SELECT count(*)::int AS added FROM information_schema.columns WHERE table_name IN
      ('creator_continuous_auto_budget_sessions','creator_continuous_auto_budget_attempts') AND column_name='evidence_mode'`)).rows)
      .toEqual([{ added: 0 }]);
    expect((await h.db.query(`SELECT count(*)::int AS preserved FROM pg_constraint
      WHERE conrelid='creator_continuous_auto_budget_sessions'::regclass AND contype='c'
        AND pg_get_expr(conbin,conrelid)='(NOT native_auto_off_attested)'`)).rows).toEqual([{ preserved: 1 }]);
  });

  it("allows only exact Ppan spend-trend authority with null room and no false attestations", async () => {
    const h = setup(); await h.web.ensureSchema(); await h.sessions.ensureSchema();
    expect(await h.sessions.arm(trendArm({ nativeAutoOffAttested: true }))).toBeNull();
    expect(await h.sessions.arm(trendArm({ noConcurrentChangesAttested: true }))).toBeNull();
    expect(await h.sessions.arm(trendArm({ liveSessionId: ROOM }))).toBeNull();
    const draft = trendArm(), s = (await h.sessions.arm(draft))!;
    expect(s).toMatchObject({ ...draft, clientId: "punpan_020", status: "ACTIVE" });
    await expect(h.db.query("UPDATE creator_continuous_auto_budget_sessions SET live_session_id=$1 WHERE session_id=$2", [ROOM, s.sessionId]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(h.db.query("UPDATE creator_continuous_auto_budget_sessions SET native_auto_off_attested=true WHERE session_id=$1", [s.sessionId]))
      .rejects.toMatchObject({ code: "23514" });
    const o = operation(s);
    await h.web.create(o);
    expect(await h.sessions.reserve({ ...s, evidenceMode: "verified-room", liveSessionId: ROOM, nativeAutoOffAttested: true,
      noConcurrentChangesAttested: true }, o.operationId, o.targetBudgetMinor)).toBeNull();
    expect(await h.sessions.reserve(s, o.operationId, o.targetBudgetMinor))
      .toMatchObject({ operationId: o.operationId, evidenceMode: "spend-trend" });
    expect(await h.sessions.isReserved(s, o.operationId)).toBe(true);
    expect((await h.db.query("SELECT live_session_id,evidence_mode FROM creator_continuous_auto_budget_attempts")).rows)
      .toEqual([{ live_session_id: null, evidence_mode: "spend-trend" }]);
    expect(await h.sessions.settleVerified(s, o.operationId, { budgetMinor: o.targetBudgetMinor, fingerprint: AFTER })).toBeNull();
    await h.web.reserve(s.ownerId, o.operationId, "live");
    await h.web.finish(s.ownerId, o.operationId, { status: "APPLIED_VERIFIED", observedBudgetMinor: o.targetBudgetMinor,
      observedFingerprint: AFTER, reason: "VERIFIED" });
    expect(await h.sessions.settleVerified(s, o.operationId, { budgetMinor: o.targetBudgetMinor, fingerprint: AFTER }))
      .toMatchObject({ operationId: null, baselineFingerprint: AFTER, evidenceMode: "spend-trend" });
  });

  it("adopts a fresh baseline by exact CAS only when the spend-trend session and writer have no pending operation", async () => {
    const h = setup(); await h.web.ensureSchema(); await h.sessions.ensureSchema();
    const strict = (await h.sessions.arm(arm()))!, next = { budgetMinor: 700_000, fingerprint: AFTER, policyRevision: strict.policyRevision };
    expect(await h.sessions.adoptBaseline(strict, next)).toBeNull();
    await h.sessions.stop(strict.ownerId, strict.sessionId);
    const s = (await h.sessions.arm(trendArm()))!;
    expect(await h.sessions.adoptBaseline(s, { ...next, policyRevision: s.policyRevision + 1 })).toBeNull();
    const manual = operation(s, next.budgetMinor, { source: "manual" });
    await h.web.create(manual); await h.web.reserve(s.ownerId, manual.operationId, "live");
    expect(await h.sessions.adoptBaseline(s, next)).toBeNull();
    await h.web.finish(s.ownerId, manual.operationId, { status: "APPLIED_VERIFIED", observedBudgetMinor: next.budgetMinor,
      observedFingerprint: next.fingerprint, reason: "VERIFIED" });
    const adopted = (await h.sessions.adoptBaseline(s, next))!;
    expect(adopted).toMatchObject({ status: "ACTIVE", baselineBudgetMinor: next.budgetMinor, baselineFingerprint: next.fingerprint,
      policyRevision: s.policyRevision, authorizedAt: s.authorizedAt, lastVerifiedAt: null, lastOutcome: null });
    expect(await h.sessions.adoptBaseline(s, { ...next, fingerprint: NEXT })).toBeNull();
    const pending = operation(adopted);
    await h.web.create(pending); await h.sessions.reserve(adopted, pending.operationId, pending.targetBudgetMinor);
    expect(await h.sessions.adoptBaseline(adopted, { ...next, fingerprint: NEXT })).toBeNull();
  });

  it("releases only an exact durable NOT_SENT attempt, then permits a new operation while keeping its audit row", async () => {
    const h = setup(); await h.web.ensureSchema(); await h.sessions.ensureSchema();
    const s = (await h.sessions.arm(trendArm()))!, first = operation(s), second = operation(s);
    await h.web.create(first); await h.web.create(second);
    await h.sessions.reserve(s, first.operationId, first.targetBudgetMinor);
    expect(await h.sessions.reserve(s, second.operationId, second.targetBudgetMinor)).toBeNull();
    await h.web.reserve(s.ownerId, first.operationId, "live");
    expect(await h.sessions.settleNotSent(s, first.operationId)).toBeNull();
    await h.web.finish(s.ownerId, first.operationId, { status: "NOT_SENT", observedBudgetMinor: null, reason: "BUDGET_AUTO_PREFLIGHT" });
    expect(await h.sessions.settleNotSent(s, first.operationId)).toMatchObject({ status: "ACTIVE", operationId: null,
      lastOutcome: "NOT_SENT", stopReason: null, baselineFingerprint: BEFORE });
    expect(await h.sessions.isReserved(s, first.operationId)).toBe(false);
    expect(await h.sessions.reserve(s, first.operationId, first.targetBudgetMinor)).toBeNull();
    expect(await h.sessions.reserve(s, second.operationId, second.targetBudgetMinor))
      .toMatchObject({ operationId: second.operationId });
    expect((await h.db.query("SELECT operation_id,retry_released FROM creator_continuous_auto_budget_attempts ORDER BY reserved_at")).rows)
      .toEqual([{ operation_id: first.operationId, retry_released: true }, { operation_id: second.operationId, retry_released: false }]);
  });

  it("does not release spend-trend expired PREPARED, uncertainty, or explicitly stopped pending operations", async () => {
    const h = setup(); await h.web.ensureSchema(); await h.sessions.ensureSchema();
    const expired = (await h.sessions.arm(trendArm()))!, a = operation(expired);
    await h.web.create(a); await h.sessions.reserve(expired, a.operationId, a.targetBudgetMinor);
    await h.db.query("UPDATE creator_web_budget_operations SET expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1", [a.operationId]);
    expect(await h.sessions.settleNotSent(expired, a.operationId)).toMatchObject({ status: "STOPPED" });
    expect(await h.sessions.arm(trendArm())).toBeNull();
    const stopped = (await h.sessions.arm(trendArm({ baselineFingerprint: AFTER })))!, b = operation(stopped);
    await h.web.create(b); await h.sessions.reserve(stopped, b.operationId, b.targetBudgetMinor);
    await h.web.reserve(stopped.ownerId, b.operationId, "live");
    await h.sessions.stop(stopped.ownerId, stopped.sessionId, "OPERATOR_STOPPED");
    await h.web.finish(stopped.ownerId, b.operationId, { status: "NOT_SENT", observedBudgetMinor: null, reason: "BUDGET_AUTO_PREFLIGHT" });
    expect(await h.sessions.settleNotSent(stopped, b.operationId)).toMatchObject({ status: "STOPPED", stopReason: "OPERATOR_STOPPED" });
    const unknown = (await h.sessions.arm(trendArm({ baselineFingerprint: NEXT })))!, c = operation(unknown);
    await h.web.create(c); await h.sessions.reserve(unknown, c.operationId, c.targetBudgetMinor);
    await h.web.reserve(unknown.ownerId, c.operationId, "live");
    await h.web.finish(unknown.ownerId, c.operationId, { status: "OUTCOME_UNKNOWN", observedBudgetMinor: null, reason: "UNKNOWN" });
    await h.sessions.markUnknown(unknown, c.operationId);
    expect(await h.sessions.settleNotSent(unknown, c.operationId)).toBeNull();
    expect((await h.db.query("SELECT DISTINCT retry_released FROM creator_continuous_auto_budget_attempts")).rows)
      .toEqual([{ retry_released: false }]);
  });

  it("retroactively releases only exact old spend-trend STOPPED/NOT_SENT writer proof and permits explicit re-arm", async () => {
    const h = setup(); await h.web.ensureSchema();
    await h.db.exec(CREATOR_CONTINUOUS_AUTO_BUDGET_SCHEMA_SQL);
    await h.db.exec(CREATOR_CONTINUOUS_SPEND_TREND_SCHEMA_SQL);
    const historical = [
      { ...trendArm(), exact: true, terminal: true },
      { ...trendArm({ baselineFingerprint: AFTER }), exact: false, terminal: true },
      { ...trendArm({ baselineFingerprint: NEXT }), exact: true, terminal: false },
    ];
    for (const old of historical) {
      const oldOp = operation(old as CreatorContinuousAutoBudgetSession, undefined, { ownerId: old.exact ? old.ownerId : old.ownerId + 1 });
      await h.web.create(oldOp);
      if (old.terminal) {
        await h.web.reserve(oldOp.ownerId, oldOp.operationId, "live");
        await h.web.finish(oldOp.ownerId, oldOp.operationId, { status: "NOT_SENT", observedBudgetMinor: null, reason: "BUDGET_AUTO_PREFLIGHT" });
      }
      await h.db.query(`INSERT INTO creator_continuous_auto_budget_sessions
        (session_id,client_id,owner_id,campaign_id,live_session_id,policy_revision,baseline_budget_minor,
          baseline_fingerprint,authorized_at,native_auto_off_attested,no_concurrent_changes_attested,evidence_mode,status,last_outcome,stop_reason)
        VALUES ($1,'punpan_020',$2,$3,NULL,$4,$5,$6,date_trunc('milliseconds',clock_timestamp()),false,false,'spend-trend','STOPPED','NOT_SENT','NOT_SENT')`,
      [old.sessionId, old.ownerId, old.campaignId, old.policyRevision, old.baselineBudgetMinor, old.baselineFingerprint]);
      await h.db.query(`INSERT INTO creator_continuous_auto_budget_attempts
        (operation_id,session_id,client_id,campaign_id,live_session_id,baseline_fingerprint,baseline_budget_minor,target_budget_minor,evidence_mode)
        VALUES ($1,$2,'punpan_020',$3,NULL,$4,$5,$6,'spend-trend')`, [oldOp.operationId, old.sessionId, old.campaignId,
        old.baselineFingerprint, old.baselineBudgetMinor, oldOp.targetBudgetMinor]);
    }
    await h.sessions.ensureSchema(); await h.sessions.ensureSchema();
    expect((await h.db.query("SELECT retry_released FROM creator_continuous_auto_budget_attempts ORDER BY baseline_fingerprint")).rows)
      .toEqual([{ retry_released: true }, { retry_released: false }, { retry_released: false }]);
    expect(await h.sessions.arm(arm())).toBeNull();
    expect(await h.sessions.arm(trendArm({ baselineFingerprint: AFTER }))).toBeNull();
    expect(await h.sessions.arm(trendArm())).toMatchObject({ status: "ACTIVE", baselineFingerprint: BEFORE });
  });
});
