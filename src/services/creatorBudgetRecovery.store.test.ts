import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { types as pgTypes } from "pg";
import { createCreatorWebBudgetStore } from "./creatorWebBudget.store";
import { createCreatorContinuousAutoBudgetStore, type CreatorContinuousAutoBudgetArmInput } from "./creatorContinuousAutoBudget.store";
import { CREATOR_BUDGET_RECOVERY_ADVERTISER, createCreatorBudgetRecoveryStore, type CreatorBudgetRecoveryEvidence,
  type CreatorBudgetRecoveryReceipt, type CreatorBudgetRecoveryRequest } from "./creatorBudgetRecovery.store";
import type { WebBudgetProposal } from "./creatorWebBudget.service";

const WRITER = "creator_web_budget_bubpa_shop189_operations", SESSION = "creator_bubpa_cauto_auto_budget_sessions";
const OLD = "1881580307345762", NEW = "1881670184981538", OWNER = 27, ACTOR = OWNER;
const BEFORE = "a".repeat(64), SETTINGS = "b".repeat(64), NON_ROI = "c".repeat(64);
const dbs: PGlite[] = [];
afterEach(async () => { for (const db of dbs.splice(0)) await db.close(); });
async function fixture() {
  const db = new PGlite(); dbs.push(db); const now = new Date(), at = now.toISOString();
  const indexMetadataQueries: string[] = [];
  let failSessionAnnotation = false;
  const database = { createQueryRunner: () => ({ connect: async () => undefined, release: async () => undefined,
    query: async (sql: string, params?: unknown[]) => {
      if (failSessionAnnotation && sql.includes(`UPDATE ${SESSION} SET quarantined_by_recovery_id`)) throw new Error("injected local transaction failure");
      if (sql.includes("CREATE TABLE")) { await db.exec(sql); return []; }
      const result = await db.query(sql, params);
      if (sql.includes("FROM pg_index i JOIN pg_class") && sql.includes(") AS columns,")) {
        indexMetadataQueries.push(sql);
        // PGlite decodes name[] unlike node-postgres. Exercise the actual pg
        // decoder so a catalog name[] (OID 1003) cannot silently pass in tests.
        const columnType = result.fields.find(field => field.name === "columns")?.dataTypeID;
        if (columnType === undefined) throw new Error("missing index column type");
        for (const row of result.rows as { columns: string[] | string }[]) {
          if (!Array.isArray(row.columns)) throw new Error("unexpected PGlite catalog array");
          row.columns = pgTypes.getTypeParser(columnType, "text")(`{${row.columns.join(",")}}`) as string[] | string;
        }
      }
      return sql.trimStart().startsWith("UPDATE") ? [result.rows, result.affectedRows ?? 0] : result.rows;
    } }) };
  const writer = createCreatorWebBudgetStore(database, "bubpa_shop189"), sessions = createCreatorContinuousAutoBudgetStore(database, "bubpa_shop189");
  await writer.ensureSchema(); await sessions.ensureSchema();
  const proposal = (campaignId = OLD): WebBudgetProposal => ({ operationId: randomUUID(), ownerId: OWNER, mode: "live", source: "auto", campaignId,
    reportingDate: at.slice(0, 10), currentBudgetMinor: 240_000, targetBudgetMinor: 288_000, projectedClientSpendMinor: 288_000,
    cap: { revision: 1, campaignCapMinor: 1_000_000, clientDailyCapMinor: 1_000_000, locked: false, readAt: at },
    fingerprint: BEFORE, expiresAt: new Date(now.getTime() + 120_000).toISOString() });
  const old = proposal(); await writer.create(old);
  const arm = (campaignId = OLD, fingerprint = BEFORE): CreatorContinuousAutoBudgetArmInput => ({ sessionId: randomUUID(), ownerId: OWNER, campaignId,
    policyRevision: 1, baselineBudgetMinor: 240_000, baselineFingerprint: fingerprint, liveSessionId: "90000000000001", nativeAutoOffAttested: true,
    noConcurrentChangesAttested: true, evidenceMode: "verified-room-spend-trend", autoDetectLive: true, keepAutoAcrossRooms: true,
    lastBoundRoomStartedAt: new Date(now.getTime() - 60_000).toISOString(), baselineSettingsFingerprint: SETTINGS, baselineNonRoiSettingsFingerprint: NON_ROI });
  const active = (await sessions.arm(arm()))!;
  await sessions.reserve(active, old.operationId, old.targetBudgetMinor, "ceil-baht"); await writer.reserve(OWNER, old.operationId, "live");
  await writer.finish(OWNER, old.operationId, { status: "OUTCOME_UNKNOWN", observedBudgetMinor: null, reason: "READBACK_UNVERIFIED" });
  await sessions.markUnknown(active, old.operationId); await sessions.stop(OWNER, active.sessionId);
  const recovery = createCreatorBudgetRecoveryStore(database, () => now);
  const request: CreatorBudgetRecoveryRequest = { recoveryId: randomUUID(), oldOperationId: old.operationId, oldCampaignId: OLD, newCampaignId: NEW, acknowledgedUnknown: true };
  const evidence: CreatorBudgetRecoveryEvidence = { clientId: "bubpa_shop189", advertiserId: CREATOR_BUDGET_RECOVERY_ADVERTISER, identityFingerprint: "d".repeat(64),
    observedAt: at, oldCampaignId: OLD, oldOperationStatus: "DISABLE", oldListOperationStatus: "DISABLE", oldBudgetMinor: 240_000,
    newCampaignId: NEW, newOperationStatus: "ENABLE", newListOperationStatus: "ENABLE", soleEnabledCampaignId: NEW, newBudgetMinor: 200_000,
    newFingerprint: "e".repeat(64), newSettingsFingerprint: "f".repeat(64), newNonRoiSettingsFingerprint: NON_ROI,
    newScheduleStartAt: new Date(now.getTime() - 120_000).toISOString(), newScheduleEndAt: null, nativeAutoState: "UNKNOWN" };
  const receipt: CreatorBudgetRecoveryReceipt = { schemaVersion: 1, clientId: "bubpa_shop189", recoveryId: request.recoveryId,
    oldOperationId: old.operationId, oldCampaignId: OLD, newCampaignId: NEW, status: "QUARANTINED", historicalOutcome: "OUTCOME_UNKNOWN", locked: false };
  const snapshot = async () => ({ writer: (await db.query(`SELECT * FROM ${WRITER} WHERE operation_id=$1`, [old.operationId])).rows[0],
    session: (await db.query(`SELECT * FROM ${SESSION} WHERE session_id=$1`, [active.sessionId])).rows[0] });
  const complete = async () => { await recovery.stage(ACTOR, request, evidence); return recovery.finalize(request.recoveryId, receipt, evidence); };
  return { db, database, writer, sessions, recovery, proposal, arm, old, active, request, evidence, receipt, snapshot, complete,
    indexMetadataQueries,
    failSessionAnnotation: () => { failSessionAnnotation = true; } };
}

describe("Bubpa audited different-campaign UNKNOWN quarantine", () => {
  it("reads catalog index keys as text[] supported by the real node-postgres decoder, not name[]", async () => {
    const f = await fixture();
    expect(pgTypes.getTypeParser(1003, "text")("{client_id}")).toBe("{client_id}");
    expect(pgTypes.getTypeParser(1009, "text")("{client_id}")).toEqual(["client_id"]);
    expect(f.indexMetadataQueries.length).toBeGreaterThanOrEqual(2);
    for (const sql of f.indexMetadataQueries) {
      const array = sql.match(/(ARRAY\([\s\S]*?\)) AS columns/)?.[1];
      expect(array).toBeDefined();
      const result = await f.db.query<{ array_type: string }>(`SELECT pg_typeof(${array})::text AS array_type FROM pg_index i
        WHERE i.indexrelid='creator_web_budget_bubpa_shop189_one_active_fence'::regclass`);
      expect(result.rows).toEqual([{ array_type: "text[]" }]);
    }
    expect(await f.writer.hasFence(NEW)).toBe(true);
  });
  it("preserves the full historical UNKNOWN and stopped session, only annotating audited quarantine", async () => {
    const f = await fixture(), before = await f.snapshot();
    const staged = await f.recovery.stage(ACTOR, f.request, f.evidence);
    expect(staged).toMatchObject({ status: "STAGED", historicalOutcome: "OUTCOME_UNKNOWN", revision: 1, oldSessionId: f.active.sessionId });
    expect(await f.writer.hasFence(NEW)).toBe(true); expect(await f.sessions.getLatest()).toMatchObject({ status: "STOPPED", operationId: f.old.operationId });
    expect(await f.recovery.finalize(f.request.recoveryId, f.receipt, f.evidence)).toMatchObject({ status: "QUARANTINED", historicalOutcome: "OUTCOME_UNKNOWN" });
    const after = await f.snapshot();
    expect(after.writer).toEqual({ ...before.writer, quarantined_by_recovery_id: f.request.recoveryId });
    expect(after.session).toEqual({ ...before.session, quarantined_by_recovery_id: f.request.recoveryId });
    expect(await f.writer.get(OWNER, f.old.operationId)).toMatchObject({ status: "OUTCOME_UNKNOWN", observedBudgetMinor: null });
    expect(await f.sessions.getLatest()).toBeNull(); expect(await f.sessions.getActive()).toBeNull();
    expect(await f.writer.hasFence(NEW)).toBe(false);
    expect(await f.writer.hasFence()).toBe(true); expect(await f.writer.hasFence(OLD)).toBe(true); expect(await f.writer.hasFence("90000000000009")).toBe(true);
  });
  it("only permits new campaign create/reserve/arm and independently fences new ambiguous attempts", async () => {
    const f = await fixture(); await f.complete();
    await expect(f.writer.create(f.proposal(OLD))).rejects.toThrow(); await expect(f.writer.create(f.proposal("90000000000009"))).rejects.toThrow();
    expect(await f.sessions.arm(f.arm(OLD, "f".repeat(64)))).toBeNull(); expect(await f.sessions.arm(f.arm("90000000000009"))).toBeNull();
    const next = { ...f.proposal(NEW), currentBudgetMinor: 200_000, targetBudgetMinor: 240_000, fingerprint: "e".repeat(64) };
    await f.writer.create(next);
    const active = (await f.sessions.arm({ ...f.arm(NEW, next.fingerprint), baselineBudgetMinor: 200_000 }))!;
    expect(active).toMatchObject({ campaignId: NEW, status: "ACTIVE" }); expect(await f.sessions.getActive()).toEqual(active);
    await f.sessions.reserve(active, next.operationId, next.targetBudgetMinor, "ceil-baht");
    expect(await f.writer.reserve(OWNER, next.operationId, "live")).toMatchObject({ status: "PROCESSING", campaignId: NEW });
    await f.writer.finish(OWNER, next.operationId, { status: "OUTCOME_UNKNOWN", observedBudgetMinor: null, reason: "READBACK_UNVERIFIED" });
    expect(await f.writer.hasFence(NEW)).toBe(true);
    expect(await f.sessions.arm(f.arm(NEW, "f".repeat(64)))).toBeNull();
    // Even a malformed annotation must not make reserve trust another audit's
    // old operation. The exact audit join, not merely non-null metadata, is authority.
    await f.db.query(`UPDATE ${WRITER} SET quarantined_by_recovery_id=$1 WHERE operation_id=$2`, [f.request.recoveryId, next.operationId]);
    expect(await f.writer.hasFence(NEW)).toBe(true);
    const another = { ...next, operationId: randomUUID() }; await f.writer.create(another);
    expect(await f.writer.reserve(OWNER, another.operationId, "live")).toBeNull();
  });
  it("lets persistent new-campaign baseline/cap/room adoption ignore only the exact quarantined old writer", async () => {
    const f = await fixture(); await f.complete();
    const row = (await f.sessions.arm(f.arm(NEW, "e".repeat(64))))!;
    const change = { liveSessionId: row.liveSessionId, lastBoundRoomStartedAt: row.lastBoundRoomStartedAt,
      budgetMinor: 250_000, fingerprint: "f".repeat(64), settingsFingerprint: SETTINGS, nonRoiSettingsFingerprint: NON_ROI, policyRevision: 2 };
    const advanced = await f.sessions.advanceContinuousSession(row, change);
    expect(advanced).toMatchObject({ campaignId: NEW, baselineBudgetMinor: 250_000, policyRevision: 2, status: "ACTIVE" });
    const pending = { ...f.proposal(NEW), fingerprint: "f".repeat(64), currentBudgetMinor: 250_000, targetBudgetMinor: 300_000, projectedClientSpendMinor: 300_000 };
    await f.writer.create(pending); await f.writer.reserve(OWNER, pending.operationId, "live");
    expect(await f.sessions.advanceContinuousSession(advanced!, { ...change, policyRevision: 3 })).toBeNull();
  });
  it("is idempotent without changing immutable quarantine snapshots or releasing a newer writer", async () => {
    const f = await fixture(), first = await f.complete();
    expect(await f.recovery.stage(ACTOR, f.request, f.evidence)).toEqual(first);
    expect(await f.recovery.finalize(f.request.recoveryId, { ...f.receipt, locked: true }, f.evidence)).toEqual(first);
    expect(await f.recovery.get(f.request.recoveryId)).toEqual(first);
    await expect(f.recovery.stage(ACTOR + 1, f.request, f.evidence)).rejects.toThrow("ID_CONFLICT");
    await expect(f.db.query("UPDATE creator_budget_unknown_recoveries SET new_campaign_id=$2 WHERE recovery_id=$1", [f.request.recoveryId, "90000000000009"])).rejects.toThrow("IMMUTABLE");
    await expect(f.db.query("DELETE FROM creator_budget_unknown_recoveries WHERE recovery_id=$1", [f.request.recoveryId])).rejects.toThrow("IMMUTABLE");
    await expect(f.writer.finish(OWNER, f.old.operationId, { status: "APPLIED_VERIFIED", observedBudgetMinor: 288_000, observedFingerprint: "f".repeat(64), reason: "FAKE_READBACK" }))
      .resolves.toMatchObject({ status: "OUTCOME_UNKNOWN", observedBudgetMinor: null });
  });
  it("rolls back audit state and both annotations when either annotation fails", async () => {
    const f = await fixture(), before = await f.snapshot(); await f.recovery.stage(ACTOR, f.request, f.evidence); f.failSessionAnnotation();
    await expect(f.recovery.finalize(f.request.recoveryId, f.receipt, f.evidence)).rejects.toThrow("injected");
    expect((await f.recovery.get(f.request.recoveryId))?.status).toBe("STAGED"); expect(await f.snapshot()).toEqual(before);
    expect(await f.writer.hasFence(NEW)).toBe(true);
  });
  it("rejects competing proposals and never permits a wrong operation or still-active old authority", async () => {
    const f = await fixture();
    await expect(f.recovery.stage(ACTOR + 1, f.request, f.evidence)).rejects.toThrow("OWNER_MISMATCH");
    await expect(f.recovery.stage(ACTOR, { ...f.request, oldOperationId: randomUUID() }, f.evidence)).rejects.toThrow("WRITER_MISMATCH");
    await f.writer.create(f.proposal(NEW));
    await expect(f.recovery.stage(ACTOR, f.request, f.evidence)).rejects.toThrow("COMPETING_PROPOSAL");
    expect(await f.recovery.get(f.request.recoveryId)).toBeNull(); expect(await f.writer.hasFence(NEW)).toBe(true);
  });
  it("rejects receipt and identity substitution or changed historical financial facts", async () => {
    const f = await fixture(); await f.recovery.stage(ACTOR, f.request, f.evidence);
    await expect(f.recovery.finalize(f.request.recoveryId, { ...f.receipt, newCampaignId: OLD }, f.evidence)).rejects.toThrow("RECEIPT_UNVERIFIED");
    await expect(f.recovery.finalize(f.request.recoveryId, f.receipt, { ...f.evidence, identityFingerprint: "f".repeat(64) })).rejects.toThrow("EVIDENCE_UNVERIFIED");
    await f.db.query(`UPDATE ${WRITER} SET reason='UNEXPECTED_ADMIN_CHANGE' WHERE operation_id=$1`, [f.old.operationId]);
    await expect(f.recovery.finalize(f.request.recoveryId, f.receipt, f.evidence)).rejects.toThrow("HISTORY_CHANGED");
    expect((await f.recovery.get(f.request.recoveryId))?.status).toBe("STAGED"); expect(await f.writer.hasFence(NEW)).toBe(true);
  });
  it("upgrades the two exact old unique indexes transactionally and idempotently, retaining all records", async () => {
    const f = await fixture(), before = await f.snapshot();
    await f.db.exec(`DROP INDEX creator_web_budget_bubpa_shop189_one_active_fence;
      DROP INDEX creator_bubpa_cauto_auto_budget_one_open_session;
      ALTER TABLE ${WRITER} DROP COLUMN quarantined_by_recovery_id;
      ALTER TABLE ${SESSION} DROP COLUMN quarantined_by_recovery_id;
      CREATE UNIQUE INDEX creator_web_budget_bubpa_shop189_one_active_fence ON ${WRITER}(client_id) WHERE status IN ('PROCESSING','OUTCOME_UNKNOWN');
      CREATE UNIQUE INDEX creator_bubpa_cauto_auto_budget_one_open_session ON ${SESSION}(client_id) WHERE status<>'STOPPED' OR operation_id IS NOT NULL;`);
    await f.recovery.ensureSchema(); await f.recovery.ensureSchema();
    expect(await f.snapshot()).toEqual(before);
    const indexes = (await f.db.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname IN ('creator_web_budget_bubpa_shop189_one_active_fence','creator_bubpa_cauto_auto_budget_one_open_session')")).rows;
    expect(indexes).toHaveLength(2); expect(indexes.every(row => row.indexdef.includes("quarantined_by_recovery_id IS NULL"))).toBe(true);
    await f.complete(); await f.writer.ensureSchema(); await f.sessions.ensureSchema();
    expect(await f.writer.hasFence(NEW)).toBe(false); expect(await f.sessions.getLatest()).toBeNull();
  });
  it("rejects an unexpected index rather than dropping or weakening it", async () => {
    const f = await fixture();
    await f.db.exec(`DROP INDEX creator_web_budget_bubpa_shop189_one_active_fence;
      CREATE UNIQUE INDEX creator_web_budget_bubpa_shop189_one_active_fence ON ${WRITER}(client_id) WHERE status='PROCESSING';`);
    await expect(f.recovery.ensureSchema()).rejects.toThrow("INDEX_UNEXPECTED");
    const definition = (await f.db.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname='creator_web_budget_bubpa_shop189_one_active_fence'")).rows[0].indexdef;
    expect(definition).not.toContain("quarantined_by_recovery_id IS NULL"); expect(await f.writer.hasFence(NEW)).toBe(true);
  });
  it("rolls back a first index migration if the second index is not the published guard", async () => {
    const f = await fixture(), before = await f.snapshot();
    await f.db.exec(`DROP INDEX creator_web_budget_bubpa_shop189_one_active_fence;
      CREATE UNIQUE INDEX creator_web_budget_bubpa_shop189_one_active_fence ON ${WRITER}(client_id) WHERE status IN ('PROCESSING','OUTCOME_UNKNOWN');
      DROP INDEX creator_bubpa_cauto_auto_budget_one_open_session;
      CREATE UNIQUE INDEX creator_bubpa_cauto_auto_budget_one_open_session ON ${SESSION}(client_id) WHERE status='ACTIVE';`);
    await expect(f.recovery.ensureSchema()).rejects.toThrow("INDEX_UNEXPECTED");
    const indexes = (await f.db.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname IN ('creator_web_budget_bubpa_shop189_one_active_fence','creator_bubpa_cauto_auto_budget_one_open_session')")).rows;
    expect(indexes.every(row => !row.indexdef.includes("quarantined_by_recovery_id IS NULL"))).toBe(true);
    expect(await f.snapshot()).toEqual(before); expect(await f.writer.hasFence(NEW)).toBe(true);
  });
  it("does not migrate or relax another creator's writer or session fences", async () => {
    const f = await fixture();
    const other = createCreatorWebBudgetStore(f.database, "myushop4"), otherSessions = createCreatorContinuousAutoBudgetStore(f.database, "myushop4");
    await other.ensureSchema(); await otherSessions.ensureSchema();
    const proposal = { ...f.proposal(), operationId: randomUUID() }; await other.create(proposal); await other.reserve(OWNER, proposal.operationId, "live");
    await other.finish(OWNER, proposal.operationId, { status: "OUTCOME_UNKNOWN", observedBudgetMinor: null, reason: "READBACK_UNVERIFIED" });
    await f.complete();
    expect(await other.hasFence(NEW)).toBe(true);
    expect((await f.db.query("SELECT 1 FROM information_schema.columns WHERE table_name='creator_web_budget_myushop4_operations' AND column_name='quarantined_by_recovery_id'")).rows).toHaveLength(0);
    expect((await f.db.query("SELECT 1 FROM information_schema.columns WHERE table_name='creator_myu_cauto_auto_budget_sessions' AND column_name='quarantined_by_recovery_id'")).rows).toHaveLength(0);
  });
});
