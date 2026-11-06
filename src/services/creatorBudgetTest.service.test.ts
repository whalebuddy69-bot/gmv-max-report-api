import { describe, expect, it, vi } from "vitest";
import { CREATOR_BINDING } from "./creatorRead.service";
import { CREATOR_BUDGET_TEST_CAMPAIGN, CreatorBudgetTestOperation, CreatorBudgetTestPermit, CreatorBudgetTestStore,
  createCreatorBudgetTestService, creatorBudgetTestFingerprint } from "./creatorBudgetTest.service";

const NOW = "2026-11-08T00:00:00.000Z", TOKEN = "private-test-token-canary-no-network";
const permit: CreatorBudgetTestPermit = {
  permitId: "ppan-one-shot-20261108", clientId: "punpan_020", binding: { ...CREATOR_BINDING },
  campaignId: CREATOR_BUDGET_TEST_CAMPAIGN, expectedBudgetMinor: 300000, targetBudgetMinor: 360000,
  capMinor: 1000000, policyRevision: 1, localDate: "2026-11-08", notBefore: "2026-11-07T23:00:00Z",
  expiresAt: "2026-11-08T05:00:00Z", nativeAutoBudgetVerifiedOff: true, exclusiveWriterConfirmed: true,
};
const request = { permitId: permit.permitId, policyRevision: 1, campaignId: permit.campaignId,
  expectedBudgetMinor: 300000, targetBudgetMinor: 360000, capMinor: 1000000 };
function memoryStore() {
  const rows = new Map<string, CreatorBudgetTestOperation>();
  const store: CreatorBudgetTestStore = {
    ensureSchema: vi.fn(async () => {}),
    get: vi.fn(async key => rows.get(key) ?? null),
    reserve: vi.fn(async (value, fingerprint) => {
      const existing = rows.get(value.permitId);
      if (existing) return { created: false, operation: existing };
      const operation: CreatorBudgetTestOperation = { permitId: value.permitId, fingerprint, permit: value,
        status: "SEND_RESERVED", postCount: 1, providerAccepted: null, observedBudgetMinor: null,
        reason: "PERMANENT_SEND_FENCE_COMMITTED", createdAt: NOW, updatedAt: NOW };
      rows.set(value.permitId, operation);
      return { created: true, operation };
    }),
    finish: vi.fn(async (key, fingerprint, update) => {
      const previous = rows.get(key)!;
      expect(previous.fingerprint).toBe(fingerprint);
      if (["SUCCEEDED", "FAILED_REJECTED", "FAILED_NOT_SENT"].includes(previous.status)) return previous;
      const value = { ...previous, ...update, providerAccepted: previous.providerAccepted === true ? true : update.providerAccepted };
      rows.set(key, value);
      return value;
    }),
  };
  return { store, rows };
}
function setup(options: Record<string, any> = {}) {
  const ledger = options.ledger ?? memoryStore();
  const state = { now: new Date(NOW), enabled: options.enabled ?? true,
    permit: { ...permit, ...options.permit } as unknown,
    info: { advertiser_id: CREATOR_BINDING.advertiserId, campaign_id: permit.campaignId, shopping_ads_type: "LIVE",
      operation_status: "ENABLE", budget: 3000, roas_bid: 30, modify_time: "2026-11-06 18:06:28",
      schedule_type: "SCHEDULE_FROM_NOW", schedule_start_time: "2026-11-06 18:05:59", schedule_end_time: "2036-11-03 18:05:59",
      store_id: "0", store_authorized_bc_id: "0", auto_budget: null,
      identity_list: [{ identity_id: CREATOR_BINDING.identityId, identity_type: CREATOR_BINDING.identityType,
        identity_authorized_bc_id: CREATOR_BINDING.identityAuthorizedBcId, store_id: null }], ...options.info },
    snapshot: { clientId: "punpan_020", source: "tiktok-creator-api", readOnly: true, observedAt: NOW,
      timezone: "Asia/Bangkok", reportingDate: "2026-11-08", binding: { ...CREATOR_BINDING }, nativeAutoBudgetState: "UNKNOWN",
      campaign: { campaignId: permit.campaignId, status: "ACTIVE", operationStatus: "ENABLE", currency: "THB",
        dailyBudgetMinor: 300000, targetRoi: 30, spendMinor: 240000, ...options.campaign },
      quality: { aggregateSpendComplete: true, aggregateSpendMinor: 250000, ...options.quality }, ...options.snapshot },
  };
  const loadToken = vi.fn(async () => TOKEN), freshSnapshot = vi.fn(async () => state.snapshot);
  const freshCampaignInfo = vi.fn(options.freshCampaignInfo ?? (async () => structuredClone(state.info)));
  const fetchImpl = vi.fn(options.fetchImpl ?? (async (url: any, init: any) => {
    expect(url).toBe("https://business-api.tiktok.com/open_api/v1.3/campaign/gmv_max/update/");
    expect(init.method).toBe("POST"); expect(init.redirect).toBe("error");
    expect(init.headers["Access-Token"]).toBe(TOKEN);
    expect(JSON.parse(init.body)).toEqual({ advertiser_id: CREATOR_BINDING.advertiserId, campaign_id: permit.campaignId, budget: 3600 });
    expect(ledger.rows.get(permit.permitId)?.status).toBe("SEND_RESERVED");
    state.info.budget = 3600;
    return new Response(JSON.stringify({ code: 0, data: {} }));
  }));
  const service = createCreatorBudgetTestService({ enabled: () => state.enabled, permit: () => state.permit,
    store: ledger.store, freshSnapshot, freshCampaignInfo, loadToken, fetchImpl: fetchImpl as typeof fetch,
    now: () => state.now });
  return { service, state, fetchImpl, freshSnapshot, freshCampaignInfo, loadToken, ...ledger };
}
describe("isolated one-shot Creator budget writer", () => {
  it("defaults safely OFF/unconfigured without any provider or DB initialization", async () => {
    const h = setup({ enabled: false }); h.state.permit = undefined;
    expect(h.service.metadata()).toMatchObject({ enabled: false, configured: false, canWriteNow: false });
    expect(await h.service.initialize()).toBe(false);
    await expect(h.service.execute(request)).rejects.toMatchObject({ code: "BUDGET_TEST_DISABLED" });
    expect(h.store.ensureSchema).not.toHaveBeenCalled(); expect(h.store.get).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled(); expect(h.loadToken).not.toHaveBeenCalled();
  });
  it("has no default dates and requires both native-off proof and exclusive writer confirmation", async () => {
    for (const patch of [{ localDate: undefined }, { notBefore: undefined }, { expiresAt: undefined },
      { nativeAutoBudgetVerifiedOff: false }, { exclusiveWriterConfirmed: false }]) {
      const h = setup({ permit: patch }); expect(await h.service.initialize()).toBe(false);
      try { const value = await h.service.execute(request); expect(value).toMatchObject({ status: "WAIT", postCount: 0, writeAttempted: false }); }
      catch (error) { expect(error).toMatchObject({ code: "EXPLICIT_PERMIT_REQUIRED" }); }
      expect(h.fetchImpl).not.toHaveBeenCalled(); expect(h.freshSnapshot).not.toHaveBeenCalled();
    }
  });
  it("does not POST today, before the approved window, after expiry, or for a mismatched reporting day", async () => {
    for (const at of ["2026-11-07T00:00:00Z", "2026-11-07T22:59:59Z", "2026-11-08T05:00:00Z", "2026-11-09T00:00:00Z"]) {
      const h = setup(); h.state.now = new Date(at);
      expect(await h.service.execute(request)).toMatchObject({ status: "WAIT", postCount: 0, lockSafeToRelease: true });
      expect(h.fetchImpl).not.toHaveBeenCalled(); expect(h.store.reserve).not.toHaveBeenCalled();
    }
    const h = setup({ snapshot: { reportingDate: "2026-11-07" } });
    await expect(h.service.execute(request)).rejects.toMatchObject({ code: "FRESH_SNAPSHOT_UNVERIFIED" });
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects arbitrary account/ROI fields, a different campaign, amount, or policy revision", async () => {
    const h = setup();
    for (const patch of [{ advertiserId: "other" }, { roi: 99 }, { campaignId: "1881012999140370" },
      { targetBudgetMinor: 432000 }, { capMinor: 2000000 }, { policyRevision: 2 }]) {
      await expect(h.service.execute({ ...request, ...patch })).rejects.toBeDefined();
    }
    expect(h.store.get).not.toHaveBeenCalled(); expect(h.fetchImpl).not.toHaveBeenCalled();
  });
  it("waits below 80% without consuming the permit", async () => {
    const h = setup({ campaign: { spendMinor: 239999 } });
    expect(await h.service.execute(request)).toMatchObject({ status: "WAIT", reason: "SPEND_THRESHOLD_NOT_REACHED", postCount: 0, writeAttempted: false });
    expect(h.store.reserve).not.toHaveBeenCalled(); expect(h.fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    { quality: { aggregateSpendComplete: false }, code: "COMPLETE_SPEND_UNAVAILABLE" },
    { quality: { aggregateSpendMinor: 950000 }, code: "DAILY_CAP_WOULD_BE_EXCEEDED" },
    { snapshot: { nativeAutoBudgetState: "ENABLED" }, code: "NATIVE_AUTO_BUDGET_ENABLED" },
    { info: { auto_budget: { auto_budget_enabled: true } }, code: "NATIVE_AUTO_BUDGET_ENABLED" },
    { info: { advertiser_id: "7646832328389263378" }, code: "CREATOR_IDENTITY_BINDING_UNVERIFIED" },
    { info: { store_id: "1234567890" }, code: "CREATOR_IDENTITY_BINDING_UNVERIFIED" },
    { info: { budget: 3200 }, code: "BASELINE_BUDGET_CHANGED" },
    { info: { schedule_start_time: "2026-11-09 00:00:00" }, code: "CAMPAIGN_SCHEDULE_NOT_ELIGIBLE" },
    { info: { modify_time: null }, code: "BASELINE_METADATA_UNVERIFIED" },
    { info: { roas_bid: 31 }, code: "APPROVED_BASELINE_CHANGED" },
    { snapshot: { observedAt: "2026-11-07T23:59:00Z" }, code: "FRESH_SNAPSHOT_UNVERIFIED" },
  ])("fails closed for unsafe data: $code", async options => {
    const h = setup(options);
    await expect(h.service.execute(request)).rejects.toMatchObject({ code: options.code });
    expect(h.fetchImpl).not.toHaveBeenCalled(); expect(h.store.reserve).not.toHaveBeenCalled();
  });
  it("detects a manual change between fresh preflight reads", async () => {
    const h = setup();
    h.freshCampaignInfo.mockImplementationOnce(async () => ({ ...h.state.info })).mockImplementationOnce(async () => ({ ...h.state.info, modify_time: "2026-11-08 00:00:00" }));
    await expect(h.service.execute(request)).rejects.toMatchObject({ code: "APPROVED_BASELINE_CHANGED" });
    expect(h.store.reserve).not.toHaveBeenCalled(); expect(h.fetchImpl).not.toHaveBeenCalled();
  });
  it("commits the send fence before ONE budget-only POST and verifies read-back", async () => {
    const h = setup();
    const value = await h.service.execute(request);
    expect(value).toMatchObject({ status: "SUCCEEDED", postCount: 1, providerAccepted: true, observedBudgetMinor: 360000, lockSafeToRelease: true });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(await h.service.execute(request)).toEqual(value);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(value)).not.toContain(TOKEN);
  });
  it("serializes concurrent duplicates through the durable reservation", async () => {
    const h = setup();
    await Promise.all(Array.from({ length: 8 }, () => h.service.execute(request)));
    expect(h.fetchImpl).toHaveBeenCalledTimes(1); expect(h.rows.size).toBe(1);
  });
  it("never resends after a process crashes immediately after reservation", async () => {
    const ledger = memoryStore();
    await ledger.store.reserve(permit, creatorBudgetTestFingerprint(permit), {});
    const restarted = setup({ ledger });
    expect(await restarted.service.execute(request)).toMatchObject({ status: "SEND_RESERVED", postCount: 1, lockSafeToRelease: false });
    expect(restarted.fetchImpl).not.toHaveBeenCalled(); expect(restarted.freshSnapshot).not.toHaveBeenCalled();
  });
  it("does not resend a timed-out POST, and target observation alone never claims success/unlocks", async () => {
    const h = setup({ fetchImpl: async () => { throw new Error(TOKEN + " provider raw URL"); } });
    expect(await h.service.execute(request)).toMatchObject({ status: "OUTCOME_UNKNOWN", providerAccepted: null, lockSafeToRelease: false });
    expect(await h.service.reconcile(permit.permitId)).toMatchObject({ status: "OUTCOME_UNKNOWN", observedBudgetMinor: 300000, lockSafeToRelease: false });
    h.state.info.budget = 3600;
    expect(await h.service.reconcile(permit.permitId)).toMatchObject({ status: "RECONCILED_TARGET_OBSERVED", providerAccepted: null, observedBudgetMinor: 360000, lockSafeToRelease: false });
    const restarted = setup({ ledger: { store: h.store, rows: h.rows } });
    expect(await restarted.service.execute(request)).toMatchObject({ status: "RECONCILED_TARGET_OBSERVED", postCount: 1 });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1); expect(restarted.fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(await h.service.status(permit.permitId))).not.toContain(TOKEN);
  });
  it("keeps an explicit provider rejection separate from an uncertain transport failure", async () => {
    const h = setup({ fetchImpl: async () => new Response(JSON.stringify({ code: 40001, message: TOKEN })) });
    expect(await h.service.execute(request)).toMatchObject({ status: "FAILED_REJECTED", providerAccepted: false, lockSafeToRelease: true });
    await h.service.execute(request); expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("does not send after a gate closes while the reservation commits", async () => {
    const h = setup(), reserve = h.store.reserve;
    h.store.reserve = async (...args) => { const value = await reserve(...args); h.state.enabled = false; return value; };
    expect(await h.service.execute(request)).toMatchObject({ status: "FAILED_NOT_SENT", postCount: 1, writeAttempted: false, lockSafeToRelease: true });
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
  it("if result persistence fails, reports uncertainty and never grants an automatic resend", async () => {
    const h = setup(); h.store.finish = vi.fn(async () => { throw new Error(TOKEN); });
    expect(await h.service.execute(request)).toMatchObject({ status: "OUTCOME_UNKNOWN", reason: "LEDGER_RESULT_UNAVAILABLE", lockSafeToRelease: false });
    expect(await h.service.execute(request)).toMatchObject({ status: "SEND_RESERVED", postCount: 1 });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });
});
