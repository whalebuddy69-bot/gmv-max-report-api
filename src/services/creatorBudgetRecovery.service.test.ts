import { describe, expect, it, vi } from "vitest";
import { createCreatorBudgetRecoveryService } from "./creatorBudgetRecovery.service";
import { CREATOR_BUDGET_RECOVERY_ADVERTISER, type CreatorBudgetRecoveryEvidence, type CreatorBudgetRecoveryRecord,
  type CreatorBudgetRecoveryReceipt, type CreatorBudgetRecoveryRequest } from "./creatorBudgetRecovery.store";

const NOW = "2026-11-13T01:00:00.000Z", ACTOR = 27;
const request: CreatorBudgetRecoveryRequest = { recoveryId: "11111111-1111-4111-8111-111111111111",
  oldOperationId: "22222222-2222-4222-8222-222222222222", oldCampaignId: "1881580307345762", newCampaignId: "1881670184981538", acknowledgedUnknown: true };
const evidence: CreatorBudgetRecoveryEvidence = { clientId: "bubpa_shop189", advertiserId: CREATOR_BUDGET_RECOVERY_ADVERTISER,
  identityFingerprint: "a".repeat(64), observedAt: NOW, oldCampaignId: request.oldCampaignId, oldOperationStatus: "DISABLE", oldListOperationStatus: "DISABLE",
  oldBudgetMinor: 240_000, newCampaignId: request.newCampaignId, newOperationStatus: "ENABLE", newListOperationStatus: "ENABLE",
  soleEnabledCampaignId: request.newCampaignId, newBudgetMinor: 200_000, newFingerprint: "b".repeat(64), newSettingsFingerprint: "c".repeat(64),
  newNonRoiSettingsFingerprint: "d".repeat(64), newScheduleStartAt: "2026-11-12T00:00:00.000Z", newScheduleEndAt: null, nativeAutoState: "UNKNOWN" };
const receipt: CreatorBudgetRecoveryReceipt = { schemaVersion: 1, clientId: "bubpa_shop189", recoveryId: request.recoveryId,
  oldOperationId: request.oldOperationId, oldCampaignId: request.oldCampaignId, newCampaignId: request.newCampaignId,
  status: "QUARANTINED", historicalOutcome: "OUTCOME_UNKNOWN", locked: false };
function fixture() {
  const trace: string[] = [];
  let saved: CreatorBudgetRecoveryRecord | null = null;
  const store = {
    get: vi.fn(async () => saved),
    stage: vi.fn(async () => { trace.push("stage"); return saved ??= { ...request, clientId: "bubpa_shop189", operatorUserId: ACTOR, revision: 1,
      oldSessionId: "33333333-3333-4333-8333-333333333333", status: "STAGED", historicalOutcome: "OUTCOME_UNKNOWN", initialEvidence: evidence,
      finalEvidence: null, receipt: null, stagedAt: NOW, quarantinedAt: null }; }),
    finalize: vi.fn(async (_id: string, accepted: CreatorBudgetRecoveryReceipt, fresh: CreatorBudgetRecoveryEvidence) => {
      trace.push("finalize"); return saved = { ...saved!, status: "QUARANTINED", finalEvidence: fresh, receipt: accepted, quarantinedAt: NOW };
    }),
  };
  const readEvidence = vi.fn(async () => { trace.push("read"); return { ...evidence }; });
  const recheckOperator = vi.fn(async () => { trace.push("authorize"); return true; });
  const releaseOldLease = vi.fn(async () => { trace.push("render"); return { ...receipt }; });
  const service = createCreatorBudgetRecoveryService({ store, readEvidence, recheckOperator, releaseOldLease, now: () => new Date(NOW) });
  return { service, store, readEvidence, recheckOperator, releaseOldLease, trace, saved: () => saved };
}

describe("explicit historical UNKNOWN quarantine", () => {
  it("stages before Render, independently rereads, and finalizes without a provider write or false success", async () => {
    const f = fixture();
    expect(await f.service.recover(ACTOR, request)).toMatchObject({ status: "QUARANTINED", historicalOutcome: "OUTCOME_UNKNOWN" });
    expect(f.trace).toEqual(["authorize", "read", "stage", "authorize", "render", "read", "authorize", "finalize"]);
    expect(f.releaseOldLease).toHaveBeenCalledTimes(1);
    expect(f.releaseOldLease).toHaveBeenCalledWith({ ...request, operatorUserId: ACTOR, revision: 1 });
    expect(f.store.finalize).toHaveBeenCalledWith(request.recoveryId, receipt, evidence);
  });
  it("returns completed retries without touching a later lease or creating an Auto authorization", async () => {
    const f = fixture(); const first = await f.service.recover(ACTOR, request);
    expect(await f.service.recover(ACTOR, request)).toEqual(first);
    expect(f.releaseOldLease).toHaveBeenCalledTimes(1); expect(f.store.finalize).toHaveBeenCalledTimes(1); expect(f.readEvidence).toHaveBeenCalledTimes(2);
  });
  it("keeps a staged record on lost Render response and retries only that same quarantine ID", async () => {
    const f = fixture(); f.releaseOldLease.mockRejectedValueOnce(new Error("lost reply"));
    await expect(f.service.recover(ACTOR, request)).rejects.toThrow("lost reply");
    expect(f.saved()?.status).toBe("STAGED"); expect(f.store.finalize).not.toHaveBeenCalled();
    expect(await f.service.recover(ACTOR, request)).toMatchObject({ status: "QUARANTINED" });
    expect(f.releaseOldLease.mock.calls).toHaveLength(2);
  });
  it.each([
    { ...request, acknowledgedUnknown: false }, { ...request, newCampaignId: request.oldCampaignId }, { ...request, recoveryId: "wrong" },
  ])("rejects missing acknowledgment, same campaign, and malformed exact IDs", async input => {
    const f = fixture(); await expect(f.service.recover(ACTOR, input as CreatorBudgetRecoveryRequest)).rejects.toMatchObject({ code: "BUDGET_RECOVERY_INPUT_INVALID" });
    expect(f.store.stage).not.toHaveBeenCalled(); expect(f.releaseOldLease).not.toHaveBeenCalled();
  });
  it.each([
    { oldOperationStatus: "ENABLE" }, { oldListOperationStatus: "ENABLE" }, { newListOperationStatus: "DISABLE" },
    { advertiserId: "7666005333864644624" }, { soleEnabledCampaignId: request.oldCampaignId }, { nativeAutoState: "ENABLED" },
    { observedAt: "2026-11-13T00:59:39.000Z" }, { newScheduleEndAt: NOW }, { unexpectedProviderField: "not-audit-data" },
  ])("does not stage or touch Render without complete fresh scope and disabled-old proof %j", async patch => {
    const f = fixture(); f.readEvidence.mockResolvedValueOnce({ ...evidence, ...patch } as CreatorBudgetRecoveryEvidence);
    await expect(f.service.recover(ACTOR, request)).rejects.toMatchObject({ code: "BUDGET_RECOVERY_EVIDENCE_UNVERIFIED" });
    expect(f.store.stage).not.toHaveBeenCalled(); expect(f.releaseOldLease).not.toHaveBeenCalled();
  });
  it.each([
    { locked: true }, { oldOperationId: "44444444-4444-4444-8444-444444444444" }, { oldCampaignId: request.newCampaignId },
    { newCampaignId: request.oldCampaignId }, { clientId: "punpan_020" }, { historicalOutcome: "APPLIED_VERIFIED" }, { unexpectedProviderField: "not-audit-data" },
  ])("leaves API fences intact for a mismatched or still-locked receipt %j", async patch => {
    const f = fixture(); f.releaseOldLease.mockResolvedValueOnce({ ...receipt, ...patch } as CreatorBudgetRecoveryReceipt);
    await expect(f.service.recover(ACTOR, request)).rejects.toMatchObject({ code: "BUDGET_RECOVERY_RECEIPT_UNVERIFIED" });
    expect(f.store.finalize).not.toHaveBeenCalled(); expect(f.saved()?.status).toBe("STAGED");
  });
  it("rereads after Render and does not finalize if the old campaign was re-enabled", async () => {
    const f = fixture(); f.readEvidence.mockResolvedValueOnce(evidence).mockResolvedValueOnce({ ...evidence, oldOperationStatus: "ENABLE" } as unknown as CreatorBudgetRecoveryEvidence);
    await expect(f.service.recover(ACTOR, request)).rejects.toMatchObject({ code: "BUDGET_RECOVERY_EVIDENCE_UNVERIFIED" });
    expect(f.store.finalize).not.toHaveBeenCalled();
  });
  it("records a fresh changed new budget/settings without reusing an old amount or issuing a write", async () => {
    const f = fixture(), changed = { ...evidence, newBudgetMinor: 210_000, newFingerprint: "e".repeat(64), newSettingsFingerprint: "f".repeat(64) };
    f.readEvidence.mockResolvedValueOnce(evidence).mockResolvedValueOnce(changed);
    expect((await f.service.recover(ACTOR, request)).finalEvidence).toEqual(changed);
  });
  it.each([1, 2, 3])("fails closed on authorization loss at check %i", async failed => {
    const f = fixture(); let n = 0; f.recheckOperator.mockImplementation(async () => ++n !== failed);
    await expect(f.service.recover(ACTOR, request)).rejects.toMatchObject({ code: "BUDGET_OPERATOR_DENIED" });
    expect(f.store.finalize).not.toHaveBeenCalled(); if (failed < 3) expect(f.releaseOldLease).not.toHaveBeenCalled();
  });
  it("does not permit another actor or campaign to reuse a staged recovery ID", async () => {
    const f = fixture(); f.releaseOldLease.mockRejectedValueOnce(new Error("lost reply"));
    await expect(f.service.recover(ACTOR, request)).rejects.toThrow();
    await expect(f.service.recover(ACTOR + 1, request)).rejects.toMatchObject({ code: "BUDGET_RECOVERY_ID_CONFLICT" });
    await expect(f.service.recover(ACTOR, { ...request, newCampaignId: "1881670184981539" })).rejects.toMatchObject({ code: "BUDGET_RECOVERY_ID_CONFLICT" });
    expect(f.releaseOldLease).toHaveBeenCalledTimes(1);
  });
});
