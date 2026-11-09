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
import { LIVE_ROOM_SPEND_TREND, VERIFIED_ROOM_CREATOR_IDS } from "./creatorBudgetScope";

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
  it("bootstraps each room-only scope independently and never accepts a legacy spend-trend permit", async () => {
    const h = setup();
    const records: Array<{ sessions: typeof h.sessions; row: CreatorContinuousAutoBudgetSession; operationId: string }> = [];
    for (const id of [...VERIFIED_ROOM_CREATOR_IDS, "nnshop5719"] as const) {
      const ledger = createCreatorWebBudgetStore(h.database, id), sessions = createCreatorContinuousAutoBudgetStore(h.database, id);
      await ledger.ensureSchema(); await sessions.ensureSchema(); await sessions.ensureSchema();
      expect(await sessions.arm(trendArm())).toBeNull();
      expect(await sessions.arm(arm())).toBeNull();
      const row = (await sessions.arm(arm({ evidenceMode: LIVE_ROOM_SPEND_TREND, baselineBudgetMinor: 250000 })))!;
      expect(row).toMatchObject({ clientId: id, liveSessionId: ROOM, evidenceMode: LIVE_ROOM_SPEND_TREND });
      const table = { ashopbytheta: "creator_ashop_cauto_auto_budget_sessions", myushop4: "creator_myu_cauto_auto_budget_sessions",
        bubpa_shop189: "creator_bubpa_cauto_auto_budget_sessions", nnshop5719: "creator_nn_cauto_auto_budget_sessions" }[id];
      await expect(h.db.query(`UPDATE ${table} SET evidence_mode='spend-trend', live_session_id=NULL,
        native_auto_off_attested=false,no_concurrent_changes_attested=false WHERE session_id=$1`, [row.sessionId])).rejects.toMatchObject({ code: "23514" });
      for (const other of records) {
        expect(await sessions.stop(other.row.ownerId, other.row.sessionId)).toBeNull();
        expect(await sessions.reserve(row, other.operationId, 300000)).toBeNull();
      }
      const proposal = operation(row);
      await ledger.create(proposal);
      expect(await sessions.reserve(row, proposal.operationId, proposal.targetBudgetMinor)).toMatchObject({ operationId: proposal.operationId });
      records.push({ sessions, row, operationId: proposal.operationId });
    }
    for (const { sessions, row, operationId } of records) expect(await sessions.getActive()).toMatchObject({ clientId: row.clientId, operationId });
  }, 30_000);

  it("upgrades an existing room-only scope and claims one exact LIVE without reserving a write while waiting", async () => {
    const h = setup(), table = "creator_ashop_cauto_auto_budget_sessions", attempts = "creator_ashop_cauto_auto_budget_attempts";
    const sessions = createCreatorContinuousAutoBudgetStore(h.database, "ashopbytheta");
    const other = createCreatorContinuousAutoBudgetStore(h.database, "ashopbytheta");
    const ledger = createCreatorWebBudgetStore(h.database, "ashopbytheta");
    const preUpgrade = (sql: string) => sql.replaceAll("creator_continuous_", "creator_ashop_cauto_").replaceAll("'punpan_020'", "'ashopbytheta'");
    await ledger.ensureSchema();
    await h.db.exec(preUpgrade(CREATOR_CONTINUOUS_AUTO_BUDGET_SCHEMA_SQL));
    await h.db.exec(preUpgrade(CREATOR_CONTINUOUS_SPEND_TREND_SCHEMA_SQL.replaceAll("'verified-room'", `'${LIVE_ROOM_SPEND_TREND}'`)));
    const old = arm({ evidenceMode: LIVE_ROOM_SPEND_TREND });
    await h.db.query(`INSERT INTO ${table}
      (session_id,client_id,owner_id,campaign_id,live_session_id,policy_revision,baseline_budget_minor,baseline_fingerprint,
        authorized_at,native_auto_off_attested,no_concurrent_changes_attested,evidence_mode)
      VALUES ($1,'ashopbytheta',$2,$3,$4,$5,$6,$7,'2026-11-08T00:00:00.000Z',true,true,$8)`,
    [old.sessionId, old.ownerId, old.campaignId, old.liveSessionId, old.policyRevision, old.baselineBudgetMinor, old.baselineFingerprint, old.evidenceMode]);
    await sessions.ensureSchema(); await other.ensureSchema();
    expect(await sessions.getActive()).toMatchObject({ ...old, authorizedAt: "2026-11-08T00:00:00.000Z" });
    await sessions.stop(old.ownerId, old.sessionId);

    const draft = arm({ evidenceMode: LIVE_ROOM_SPEND_TREND, liveSessionId: null, baselineBudgetMinor: 250_000 });
    const waiting = (await sessions.arm(draft))!;
    expect(waiting).toMatchObject({ ...draft, status: "ACTIVE", operationId: null });
    expect(await other.getActive()).toEqual(waiting);
    expect(await other.arm(arm({ evidenceMode: LIVE_ROOM_SPEND_TREND, liveSessionId: null }))).toBeNull();
    await expect(h.db.query(`UPDATE ${table} SET operation_id=$1 WHERE session_id=$2`, [randomUUID(), waiting.sessionId]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(h.db.query(`UPDATE ${table} SET last_verified_at=clock_timestamp() WHERE session_id=$1`, [waiting.sessionId]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(h.db.query(`INSERT INTO ${attempts}
      (operation_id,session_id,client_id,campaign_id,live_session_id,baseline_fingerprint,baseline_budget_minor,target_budget_minor,evidence_mode)
      VALUES ($1,$2,'ashopbytheta',$3,NULL,$4,250000,300000,$5)`,
    [randomUUID(), waiting.sessionId, waiting.campaignId, waiting.baselineFingerprint, waiting.evidenceMode]))
      .rejects.toMatchObject({ code: "23514" });
    const proposal = operation(waiting);
    await ledger.create(proposal);
    expect(await sessions.reserve(waiting, proposal.operationId, proposal.targetBudgetMinor)).toBeNull();
    expect(await sessions.bindLiveSession(waiting, "invalid")).toBeNull();
    expect(await sessions.bindLiveSession({ ...waiting, ownerId: 23 }, ROOM)).toBeNull();
    expect(await sessions.bindLiveSession({ ...waiting, policyRevision: 3 }, ROOM)).toBeNull();
    expect(await sessions.bindLiveSession({ ...waiting, baselineFingerprint: AFTER }, ROOM)).toBeNull();
    expect(await sessions.bindLiveSession({ ...waiting, baselineBudgetMinor: 350_000 }, ROOM)).toBeNull();
    const bound = (await other.bindLiveSession(waiting, ROOM))!;
    expect(bound).toEqual({ ...waiting, liveSessionId: ROOM });
    expect(await sessions.bindLiveSession(waiting, "12000000000003")).toBeNull();
    expect(await sessions.reserve(waiting, proposal.operationId, proposal.targetBudgetMinor)).toBeNull();
    expect(await sessions.reserve(bound, proposal.operationId, proposal.targetBudgetMinor)).toMatchObject({ operationId: proposal.operationId });
  }, 30_000);

  it("binds independent scheduled waits and does not bind a stopped session or a legacy spend-trend session", async () => {
    const h = setup();
    const ashop = createCreatorContinuousAutoBudgetStore(h.database, "ashopbytheta");
    const bubpa = createCreatorContinuousAutoBudgetStore(h.database, "bubpa_shop189");
    const myu = createCreatorContinuousAutoBudgetStore(h.database, "myushop4");
    const nn = createCreatorContinuousAutoBudgetStore(h.database, "nnshop5719");
    await ashop.ensureSchema(); await bubpa.ensureSchema(); await myu.ensureSchema(); await nn.ensureSchema(); await h.sessions.ensureSchema();
    const input = arm({ evidenceMode: LIVE_ROOM_SPEND_TREND, liveSessionId: null });
    const a = (await ashop.arm(input))!, b = (await bubpa.arm(input))!;
    const m = (await myu.arm(input))!, n = (await nn.arm(input))!;
    expect(m).toMatchObject({ clientId: "myushop4", liveSessionId: null });
    expect(n).toMatchObject({ clientId: "nnshop5719", liveSessionId: null });
    expect(await ashop.bindLiveSession(b, ROOM)).toBeNull();
    expect(await myu.bindLiveSession(a, ROOM)).toBeNull();
    expect(await nn.bindLiveSession(m, ROOM)).toBeNull();
    const trend = (await h.sessions.arm(trendArm()))!;
    expect(await h.sessions.bindLiveSession(trend, ROOM)).toBeNull();
    expect(await ashop.stop(a.ownerId, a.sessionId)).toMatchObject({ status: "STOPPED", liveSessionId: null });
    expect(await ashop.bindLiveSession(a, ROOM)).toBeNull();
    expect(await bubpa.bindLiveSession(b, ROOM)).toMatchObject({ status: "ACTIVE", liveSessionId: ROOM });
    expect(await myu.bindLiveSession(m, ROOM)).toMatchObject({ status: "ACTIVE", liveSessionId: ROOM });
    expect(await nn.bindLiveSession(n, ROOM)).toMatchObject({ status: "ACTIVE", liveSessionId: ROOM });
  }, 30_000);

  it("migrates Ppan and Srihiw in place, keeping each legacy pending send and requiring a room for new hybrid attempts", async () => {
    const h = setup();
    for (const id of ["punpan_020", "srihiw"] as const) {
      const sessions = createCreatorContinuousAutoBudgetStore(h.database, id), ledger = createCreatorWebBudgetStore(h.database, id);
      const prefix = id === "srihiw" ? "creator_srihiw_continuous_" : "creator_continuous_";
      const table = `${prefix}auto_budget_sessions`, attempts = `${prefix}auto_budget_attempts`;
      const preUpgrade = (sql: string) => sql.replaceAll("creator_continuous_", prefix).replaceAll("'punpan_020'", `'${id}'`);
      await ledger.ensureSchema();
      await h.db.exec(preUpgrade(CREATOR_CONTINUOUS_AUTO_BUDGET_SCHEMA_SQL));
      await h.db.exec(preUpgrade(CREATOR_CONTINUOUS_SPEND_TREND_SCHEMA_SQL));
      const old = id === "srihiw" ? trendArm({ baselineBudgetMinor: 250_000 }) : arm({ evidenceMode: "verified-room", baselineBudgetMinor: 250_000 });
      const pendingId = randomUUID();
      await h.db.query(`INSERT INTO ${table}
        (session_id,client_id,owner_id,campaign_id,live_session_id,policy_revision,baseline_budget_minor,baseline_fingerprint,
          authorized_at,native_auto_off_attested,no_concurrent_changes_attested,evidence_mode,operation_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'2026-11-08T00:00:00.000Z',$9,$10,$11,$12)`,
      [old.sessionId, id, old.ownerId, old.campaignId, old.liveSessionId, old.policyRevision, old.baselineBudgetMinor, old.baselineFingerprint,
        old.nativeAutoOffAttested, old.noConcurrentChangesAttested, old.evidenceMode, pendingId]);
      await h.db.query(`INSERT INTO ${attempts}
        (operation_id,session_id,client_id,campaign_id,live_session_id,baseline_fingerprint,baseline_budget_minor,target_budget_minor,evidence_mode)
        VALUES ($1,$2,$3,$4,$5,$6,$7,300000,$8)`,
      [pendingId, old.sessionId, id, old.campaignId, old.liveSessionId, old.baselineFingerprint, old.baselineBudgetMinor, old.evidenceMode]);
      const [before] = (await h.db.query(`SELECT * FROM ${table}`)).rows;
      await sessions.ensureSchema(); await sessions.ensureSchema();
      const pending = (await sessions.getActive())!;
      expect(pending).toMatchObject({ ...old, status: "ACTIVE", operationId: pendingId });
      expect((await h.db.query(`SELECT * FROM ${table}`)).rows).toEqual([before]);
      expect((await h.db.query(`SELECT operation_id,live_session_id,evidence_mode,retry_released FROM ${attempts}`)).rows)
        .toEqual([{ operation_id: pendingId, live_session_id: old.liveSessionId, evidence_mode: old.evidenceMode, retry_released: false }]);
      if (id === "punpan_020") await expect(h.db.query(`UPDATE ${table} SET live_session_id=NULL WHERE session_id=$1`, [old.sessionId]))
        .rejects.toMatchObject({ code: "23514" });
      const waitingInput = arm({ evidenceMode: LIVE_ROOM_SPEND_TREND, liveSessionId: null, baselineFingerprint: AFTER, baselineBudgetMinor: 250_000 });
      expect(await sessions.arm(waitingInput)).toBeNull();
      const legacyOp = operation(pending, 300_000, { operationId: pendingId });
      await ledger.create(legacyOp); await ledger.reserve(pending.ownerId, pendingId, "live");
      await ledger.finish(pending.ownerId, pendingId, { status: "NOT_SENT", observedBudgetMinor: null, reason: "PRECHECK" });
      expect(await sessions.settleNotSent(pending, pendingId)).toMatchObject({ operationId: null, lastOutcome: "NOT_SENT" });
      if (id === "srihiw") await sessions.stop(pending.ownerId, pending.sessionId);

      const waiting = (await sessions.arm(waitingInput))!;
      expect(waiting).toMatchObject({ ...waitingInput, status: "ACTIVE" });
      await expect(h.db.query(`INSERT INTO ${attempts}
        (operation_id,session_id,client_id,campaign_id,live_session_id,baseline_fingerprint,baseline_budget_minor,target_budget_minor,evidence_mode)
        VALUES ($1,$2,$3,$4,NULL,$5,250000,300000,$6)`,
      [randomUUID(), waiting.sessionId, id, waiting.campaignId, waiting.baselineFingerprint, waiting.evidenceMode]))
        .rejects.toMatchObject({ code: "23514" });
      expect(await sessions.bindLiveSession(waiting, ROOM)).toMatchObject({ liveSessionId: ROOM, baselineFingerprint: AFTER });
    }
  }, 30_000);

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
