import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { createCreatorContinuousAutoBudgetStore, type CreatorContinuousAutoBudgetSession } from "./creatorContinuousAutoBudget.store";
import { createCreatorWebBudgetStore } from "./creatorWebBudget.store";
import type { WebBudgetProposal } from "./creatorWebBudget.service";
import { createPpanAutoObservabilityStore } from "./ppanAutoObservability.store";
import { LIVE_ROOM_SPEND_TREND } from "./creatorBudgetScope";

const CAMPAIGN = "12000000000001";
const ROOM = "12000000000002";
const OLD_FINGERPRINT = "a".repeat(64);
const NEW_FINGERPRINT = "b".repeat(64);
const OWNER = 17;
const OTHER_OWNER = 23;
const instances: PGlite[] = [];
afterEach(async () => { for (const db of instances.splice(0)) await db.close(); });

function fixture() {
  const db = new PGlite(); instances.push(db);
  const statements: string[] = [];
  const database = { createQueryRunner: () => ({ connect: async () => undefined, release: async () => undefined,
    query: async (sql: string, params?: unknown[]) => {
      statements.push(sql);
      if (sql.includes("CREATE TABLE")) { await db.exec(sql); return []; }
      const result = await db.query(sql, params);
      return sql.trimStart().startsWith("UPDATE") ? [result.rows, result.affectedRows ?? 0] : result.rows;
    } }) };
  return { db, statements, obs: createPpanAutoObservabilityStore(database), sessions: createCreatorContinuousAutoBudgetStore(database),
    web: createCreatorWebBudgetStore(database), foreign: createCreatorWebBudgetStore(database, "srihiw") };
}

async function arm(h: ReturnType<typeof fixture>, ownerId = OWNER) {
  const row = await h.sessions.arm({ sessionId: randomUUID(), ownerId, campaignId: CAMPAIGN, liveSessionId: ROOM, policyRevision: 2,
    baselineBudgetMinor: 900_000, baselineFingerprint: OLD_FINGERPRINT, nativeAutoOffAttested: true, noConcurrentChangesAttested: true });
  if (!row) throw new Error("fixture session not armed");
  return row;
}

function draft(session: CreatorContinuousAutoBudgetSession, change: Partial<WebBudgetProposal> = {}): WebBudgetProposal {
  return { operationId: randomUUID(), mode: "live", source: "auto", ownerId: session.ownerId, campaignId: session.campaignId,
    reportingDate: "2026-11-08", currentBudgetMinor: 900_000, targetBudgetMinor: 1_080_000, projectedClientSpendMinor: 1_080_000,
    cap: { revision: 2, campaignCapMinor: 2_000_000, clientDailyCapMinor: 2_000_000, locked: false, readAt: new Date().toISOString() },
    fingerprint: session.baselineFingerprint, expiresAt: new Date(Date.now() + 120_000).toISOString(), ...change };
}

describe("Ppan Auto observability", () => {
  it("defers only the older persistent context-read alert and retains the independent heartbeat and other health alerts", async () => {
    const h = fixture(); await h.sessions.ensureSchema(); await h.obs.ensureSchema();
    const session = (await h.sessions.arm({ sessionId: randomUUID(), ownerId: OWNER, campaignId: CAMPAIGN, liveSessionId: null,
      policyRevision: 2, baselineBudgetMinor: 900_000, baselineFingerprint: OLD_FINGERPRINT, nativeAutoOffAttested: true,
      noConcurrentChangesAttested: true, evidenceMode: LIVE_ROOM_SPEND_TREND, autoDetectLive: true, keepAutoAcrossRooms: true,
      baselineSettingsFingerprint: OLD_FINGERPRINT }))!;
    await h.db.query("UPDATE creator_continuous_auto_budget_sessions SET authorized_at=clock_timestamp()-interval '10 minutes' WHERE session_id=$1", [session.sessionId]);
    await h.obs.recordTick({ sessionId: session.sessionId, checkedAt: new Date(Date.now() - 240_000).toISOString(), reason: "CONTEXT_UNAVAILABLE" });
    expect((await h.obs.watchState(true)).incident?.kind).toBe("HEARTBEAT_STALE");
    await h.obs.recordTick({ sessionId: session.sessionId, checkedAt: new Date(Date.now() - 20_000).toISOString(), reason: "CONTEXT_UNAVAILABLE" });
    expect((await h.obs.watchState()).incident?.kind).toBe("CHECKS_FAILING");
    expect((await h.obs.watchState(true)).incident).toBeNull();
    await h.obs.recordTick({ sessionId: session.sessionId, checkedAt: new Date().toISOString(), reason: "LINE_NOT_READY" });
    expect((await h.obs.watchState(true)).incident?.kind).toBe("CHECKS_FAILING");
  });

  it("stores only completed ticks for the latest exact session and keeps the last valid read across later failures", async () => {
    const h = fixture(); await h.sessions.ensureSchema(); await h.web.ensureSchema();
    await expect(h.obs.status(OWNER)).rejects.toThrow("PPAN_AUTO_OBSERVABILITY_UNAVAILABLE");
    expect(h.statements.at(-1)).toBe("ROLLBACK");
    await h.obs.ensureSchema(); await h.obs.ensureSchema();
    const a = await arm(h);
    const at = Date.now();
    const stamp = (offset: number) => new Date(at + offset).toISOString();
    await h.obs.recordTick({ sessionId: a.sessionId, checkedAt: stamp(3), lastValidReadAt: stamp(2), reason: "BELOW_THRESHOLD" });
    await h.obs.recordTick({ sessionId: a.sessionId, checkedAt: stamp(4), reason: "CONTEXT_UNAVAILABLE" });
    await h.obs.recordTick({ sessionId: a.sessionId, checkedAt: stamp(1), reason: "NOT_ARMED" });
    await h.obs.recordTick({ sessionId: randomUUID(), checkedAt: stamp(5), reason: "ERROR" });
    await expect(h.obs.recordTick({ sessionId: a.sessionId, checkedAt: stamp(3), lastValidReadAt: stamp(4), reason: "ERROR" })).rejects.toThrow("PPAN_AUTO_OBSERVABILITY_INPUT");
    expect(await h.obs.status(OWNER)).toEqual({ lastTickAt: stamp(4), lastValidReadAt: stamp(2), reason: "CONTEXT_UNAVAILABLE", heartbeatStale: false, history: [] });
    expect(await h.obs.status(OTHER_OWNER)).toEqual({ lastTickAt: null, lastValidReadAt: null, reason: null, heartbeatStale: false, history: [] });
    await h.sessions.stop(OWNER, a.sessionId);
    const b = await arm(h, OTHER_OWNER);
    const newTick = new Date(Math.max(Date.parse(stamp(7)), Date.parse(b.authorizedAt) + 1)).toISOString();
    await h.obs.recordTick({ sessionId: a.sessionId, checkedAt: newTick, reason: "ERROR" });
    await h.obs.recordTick({ sessionId: b.sessionId, checkedAt: newTick, reason: "PENDING" });
    expect(await h.obs.status(OTHER_OWNER)).toMatchObject({ lastTickAt: newTick, lastValidReadAt: null, reason: "PENDING" });
    expect(await h.obs.status(OWNER)).toMatchObject({ lastTickAt: null, lastValidReadAt: null, reason: null });
  });

  it("shows verified amounts for exact owner Auto attempts and excludes manual, unrelated Auto and foreign-account writes", async () => {
    const h = fixture(); await h.web.ensureSchema(); await h.foreign.ensureSchema(); await h.sessions.ensureSchema(); await h.obs.ensureSchema();
    const session = await arm(h);
    expect(await h.obs.watchState()).toEqual({ armState: "ACTIVE", sessionId: session.sessionId, incident: null });
    const exact = draft(session), manual = draft(session, { source: "manual" }), foreign = draft(session), unbound = draft(session);
    for (const [ledger, proposal] of [[h.web, manual], [h.web, unbound], [h.foreign, foreign], [h.web, exact]] as const) {
      await ledger.create(proposal);
      if (proposal === exact) await h.sessions.reserve(session, proposal.operationId, proposal.targetBudgetMinor);
      await ledger.reserve(OWNER, proposal.operationId, "live");
      await ledger.finish(OWNER, proposal.operationId, { status: "APPLIED_VERIFIED", observedBudgetMinor: proposal.targetBudgetMinor,
        observedFingerprint: NEW_FINGERPRINT, reason: "EXACT_PROVIDER_READBACK" });
    }
    const view = await h.obs.status(OWNER);
    expect(view.history).toEqual([{ operationId: exact.operationId, checkedAt: expect.any(String), status: "APPLIED_VERIFIED",
      previousBudgetMinor: 900_000, targetBudgetMinor: 1_080_000, observedBudgetMinor: 1_080_000, reason: "EXACT_PROVIDER_READBACK" }]);
    expect(JSON.stringify(view)).not.toContain(NEW_FINGERPRINT);
    expect((await h.obs.status(OTHER_OWNER)).history).toEqual([]);
    await h.db.query("UPDATE creator_web_budget_operations SET reason='PRIVATE_IMPLEMENTATION_DETAILS' WHERE operation_id=$1", [exact.operationId]);
    expect((await h.obs.status(OWNER)).history[0].reason).toBe("UNCLASSIFIED");
  });

  it("distinguishes stale heartbeat, sustained failed reads and an unknown operation, with one persistent LINE retry key per incident", async () => {
    const h = fixture(); await h.web.ensureSchema(); await h.sessions.ensureSchema(); await h.obs.ensureSchema();
    const session = await arm(h);
    expect(await h.obs.watchdog()).toBeNull();
    await h.db.query("UPDATE creator_continuous_auto_budget_sessions SET authorized_at=clock_timestamp()-interval '5 minutes' WHERE session_id=$1", [session.sessionId]);
    // A pre-existing authorization is not evidence that the newly installed
    // monitor missed a tick. Only the monitor's own elapsed time counts.
    expect(await h.obs.watchdog()).toBeNull();
    expect((await h.obs.status(OWNER)).heartbeatStale).toBe(false);
    await h.db.query("UPDATE creator_ppan_auto_observability_epoch SET installed_at=clock_timestamp()-interval '5 minutes' WHERE client_id='punpan_020'");
    await h.obs.ensureSchema(); // Restart must not reset the persisted window.
    const stale = (await h.obs.watchdog())!;
    expect(stale).toMatchObject({ kind: "HEARTBEAT_STALE", sessionId: session.sessionId });
    expect((await h.obs.status(OWNER)).heartbeatStale).toBe(true);
    const firstKey = randomUUID(), another = randomUUID();
    expect(await h.obs.reserveAlert(stale, firstKey)).toBe(firstKey);
    expect(await h.obs.reserveAlert(stale, another)).toBe(firstKey);
    expect(await h.obs.markAlertAccepted(stale, another)).toBe(false);
    expect(await h.obs.markAlertAccepted(stale, firstKey)).toBe(true);
    expect(await h.obs.watchdog()).toBeNull();
    expect(await h.obs.reserveAlert(stale, another)).toBeNull();
    await h.obs.recordTick({ sessionId: session.sessionId, checkedAt: new Date(Date.now() - 240_000).toISOString(), reason: "CONTEXT_UNAVAILABLE" });
    await h.obs.recordTick({ sessionId: session.sessionId, checkedAt: new Date().toISOString(), reason: "ERROR" });
    const failed = (await h.obs.watchdog())!;
    expect(failed).toMatchObject({ kind: "CHECKS_FAILING", sessionId: session.sessionId });
    expect((await h.obs.status(OWNER)).heartbeatStale).toBe(false);
    const current = (await h.sessions.getLatest())!;
    const uncertain = draft(current);
    await h.web.create(uncertain);
    await h.sessions.reserve(current, uncertain.operationId, uncertain.targetBudgetMinor);
    await h.web.reserve(OWNER, uncertain.operationId, "live");
    await h.web.finish(OWNER, uncertain.operationId, { status: "OUTCOME_UNKNOWN", observedBudgetMinor: null, reason: "READBACK_UNVERIFIED" });
    await h.sessions.markUnknown(current, uncertain.operationId);
    expect(await h.obs.watchdog()).toEqual({ kind: "OUTCOME_UNKNOWN", sessionId: session.sessionId, incidentKey: uncertain.operationId });
    expect(await h.obs.reserveAlert(failed, another)).toBeNull();
    expect((await h.obs.status(OWNER)).history[0]).toMatchObject({ operationId: uncertain.operationId, status: "OUTCOME_UNKNOWN", observedBudgetMinor: null });
    await h.sessions.stop(OWNER, session.sessionId);
    expect(await h.obs.watchState()).toEqual({ armState: "INACTIVE", sessionId: session.sessionId,
      incident: { kind: "OUTCOME_UNKNOWN", sessionId: session.sessionId, incidentKey: uncertain.operationId } });
  });
});
