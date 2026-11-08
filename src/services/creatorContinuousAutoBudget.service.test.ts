import { describe, expect, it, vi } from "vitest";
import { createCreatorContinuousAutoBudgetService } from "./creatorContinuousAutoBudget.service";
import type { CreatorContinuousAutoBudgetSession, createCreatorContinuousAutoBudgetStore } from "./creatorContinuousAutoBudget.store";
import { createCreatorWebBudgetService, type WebBudgetAdapters, type WebBudgetContext, type WebBudgetPolicy,
  type WebBudgetRecord, type WebBudgetStore } from "./creatorWebBudget.service";

const OWNER = 123;
const CAMPAIGN = "1234567890123456";
const ROOM = "2234567890123456";
const OTHER_ROOM = "3234567890123456";
const ORIGINAL_BUDGET = 650_000;
const ORIGINAL_THRESHOLD = 520_000;
const CAP_REVISION = 7;
const CONFIRM = { expectedCampaignId: CAMPAIGN, expectedLiveSessionId: ROOM, expectedBudgetMinor: ORIGINAL_BUDGET,
  expectedPolicyRevision: CAP_REVISION, nativeAutoOff: true, noConcurrentChanges: true } as const;
const ts = (ms: number) => new Date(ms).toISOString();

function fixture(mode: "shadow" | "live" = "live", evidence: "verified-room" | "spend-trend" = "verified-room") {
  let clock = Date.parse("2026-11-07T14:14:00.000Z");
  let session: CreatorContinuousAutoBudgetSession | null = null;
  let context: WebBudgetContext = {
    campaignId: CAMPAIGN, reportingDate: "2026-11-07", observedAt: ts(clock), budgetMinor: ORIGINAL_BUDGET,
    spendMinor: ORIGINAL_THRESHOLD, aggregateSpendMinor: ORIGINAL_THRESHOLD + 2_000, fingerprint: "a".repeat(64),
    nativeAutoState: "DISABLED", liveDeliveryState: "LIVE", deliveryVerified: true, liveSessionId: ROOM,
    providerSpendObservedAt: ts(clock - 1000),
  };
  let policy: WebBudgetPolicy = { revision: CAP_REVISION, readAt: ts(clock), campaignCapMinor: 1_000_000,
    clientDailyCapMinor: 1_100_000, autoLineReady: true, locked: false };
  const records = new Map<string, WebBudgetRecord>();
  const writes: number[] = [];
  const lineOutbox = new Set<string>();
  const getOp = (ownerId: number, operationId: string) => {
    const record = records.get(operationId);
    return record?.ownerId === ownerId ? record : null;
  };
  const ledger: WebBudgetStore = {
    create: vi.fn(async row => { records.set(row.operationId, { ...row, status: "PREPARED", observedBudgetMinor: null }); }),
    get: vi.fn(async (owner, id) => getOp(owner, id)),
    hasFence: vi.fn(async () => [...records.values()].some(r => r.status === "PROCESSING" || r.status === "OUTCOME_UNKNOWN")),
    reserve: vi.fn(async (owner, id) => {
      const row = getOp(owner, id);
      if (row?.status !== "PREPARED") return null;
      const pending = { ...row, status: "PROCESSING" as const };
      records.set(id, pending);
      return pending;
    }),
    finish: vi.fn(async (owner, id, result) => {
      const row = getOp(owner, id);
      if (!row) throw new Error("operation missing");
      const settled = { ...row, ...result };
      records.set(id, settled);
      return settled;
    }),
  };
  const save = (next: Partial<CreatorContinuousAutoBudgetSession>) => {
    if (!session) return null;
    session = { ...session, ...next };
    return session;
  };
  const isPending = (prior: CreatorContinuousAutoBudgetSession, id: string) => session?.sessionId === prior.sessionId && session.operationId === id;
  const sessions: ReturnType<typeof createCreatorContinuousAutoBudgetStore> = {
    ensureSchema: vi.fn(async () => {}), getActive: vi.fn(async () => session?.status === "STOPPED" && !session.operationId ? null : session),
    getLatest: vi.fn(async () => session),
    arm: vi.fn(async input => {
      if (session && (session.status !== "STOPPED" || session.operationId)) return null;
      return session = { ...input, evidenceMode: input.evidenceMode ?? "verified-room", clientId: "punpan_020", status: "ACTIVE", authorizedAt: ts(clock),
        operationId: null, lastOutcome: null, lastVerifiedAt: null, stopReason: null };
    }),
    adoptBaseline: vi.fn(async (prior, next) => session?.sessionId === prior.sessionId && session.status === "ACTIVE" && !session.operationId
      ? save({ baselineBudgetMinor: next.budgetMinor, baselineFingerprint: next.fingerprint }) : null),
    reserve: vi.fn(async (prior, id) => session && session.sessionId === prior.sessionId && session.status === "ACTIVE" && !session.operationId
      ? save({ operationId: id, lastOutcome: null }) : null),
    isReserved: vi.fn(async (prior, id) => isPending(prior, id) && session?.status === "ACTIVE"),
    markUnknown: vi.fn(async (prior, id) => isPending(prior, id) ? save({ status: "BLOCKED", lastOutcome: "OUTCOME_UNKNOWN" }) : null),
    settleVerified: vi.fn(async (prior, id, next) => isPending(prior, id) ? save({ operationId: null,
      baselineBudgetMinor: next.budgetMinor, baselineFingerprint: next.fingerprint, lastOutcome: "APPLIED_VERIFIED", lastVerifiedAt: ts(clock) }) : null),
    settleNotSent: vi.fn(async (prior, id) => isPending(prior, id) ? save({ status: "STOPPED", operationId: null,
      lastOutcome: "NOT_SENT", stopReason: "NOT_SENT" }) : null),
    stop: vi.fn(async (owner, id, reason = "OPERATOR_STOPPED") => session && session.ownerId === owner && session.sessionId === id
      ? save({ status: "STOPPED", stopReason: reason }) : null),
  };
  const dispatch = vi.fn<WebBudgetAdapters["dispatch"]>(async input => {
    if (!await input.canSend(context)) return { outcome: "NOT_SENT" };
    writes.push(input.targetBudgetMinor);
    const fingerprint = String.fromCharCode(97 + writes.length).repeat(64);
    context = { ...context, budgetMinor: input.targetBudgetMinor, fingerprint };
    return { outcome: "APPLIED_VERIFIED", observedBudgetMinor: context.budgetMinor, observedFingerprint: fingerprint };
  });
  const adapters: WebBudgetAdapters = {
    readPolicy: vi.fn(async () => policy),
    readContext: vi.fn(async () => context),
    acquireLease: vi.fn(async operationId => ({ ...policy, locked: true, operationId, expiresAt: ts(clock + 60_000) })),
    finishLease: vi.fn(async (operationId, outcome) => { if (outcome === "APPLIED_VERIFIED") lineOutbox.add(operationId); }),
    dispatch,
  };
  const discover = vi.fn<() => Promise<string | null>>(async () => CAMPAIGN);
  const now = () => new Date(clock);
  const writer = createCreatorWebBudgetService({ store: ledger, adapters, mode: () => "live", now });
  const service = createCreatorContinuousAutoBudgetService({ mode: () => mode, discover, adapters, sessions, writer,
    ledger, recheckOwner: async (owner, authorizedAt) => owner === OWNER && authorizedAt === session?.authorizedAt,
    legacyBusy: async () => false, evidenceMode: () => evidence, now });
  return { service, sessions, discover, dispatch, ledger, writes, lineOutbox, readContext: () => context,
    arm: () => service.arm(OWNER, evidence === "spend-trend" ? { expectedCampaignId: CAMPAIGN, expectedBudgetMinor: ORIGINAL_BUDGET,
      expectedPolicyRevision: CAP_REVISION, evidenceMode: evidence } : CONFIRM, async () => true),
    refresh: (deltaMs = 0, changes: Partial<WebBudgetContext> = {}) => {
      clock += deltaMs;
      context = { ...context, observedAt: ts(clock), ...changes };
      policy = { ...policy, readAt: ts(clock) };
    },
  };
}

describe("Ppan continuous budget automation", () => {
  it("shows a shadow preview but cannot arm even with positive provider evidence", async () => {
    const f = fixture("shadow");
    expect(await f.service.status(true, OWNER)).toMatchObject({ strategy: "continuous", mode: "shadow", canArm: false,
      preview: { status: "WOULD_INCREASE", targetBudgetMinor: 780_000 } });
    await expect(f.arm()).rejects.toMatchObject({ code: "AUTO_BUDGET_NOT_READY" });
    await f.service.tick();
    expect(f.sessions.arm).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("does not arm without provider native Auto, spend freshness and exact LIVE evidence", async () => {
    const f = fixture();
    f.refresh(0, { nativeAutoState: "UNKNOWN", providerSpendObservedAt: null, deliveryVerified: false, liveSessionId: null });
    const status = await f.service.status(true, OWNER);
    expect(status.canArm).toBe(false);
    expect(status.blockers).toEqual(expect.arrayContaining(["NATIVE_AUTO_UNVERIFIED", "SPEND_WATERMARK_MISSING", "LIVE_DELIVERY_UNVERIFIED"]));
    await expect(f.arm()).rejects.toMatchObject({ code: "AUTO_BUDGET_NOT_READY" });
    expect(f.sessions.arm).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("cannot arm if the verified room changes after the operator's preview", async () => {
    const f = fixture();
    expect(await f.service.status(true, OWNER)).toMatchObject({ canArm: true, preview: { liveSessionId: ROOM } });
    f.refresh(0, { liveSessionId: OTHER_ROOM });
    await expect(f.arm()).rejects.toMatchObject({ code: "AUTO_BUDGET_NOT_READY" });
    expect(f.sessions.arm).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("writes twice at 80% using verified readbacks, only after each fresh provider watermark", async () => {
    const f = fixture();
    f.refresh(0, { spendMinor: ORIGINAL_THRESHOLD - 1 });
    expect(await f.service.status(true, OWNER)).toMatchObject({ canArm: true, preview: { status: "BELOW_THRESHOLD" } });
    await f.arm();
    await f.service.tick();
    expect(f.writes).toEqual([]);

    f.refresh(0, { spendMinor: ORIGINAL_THRESHOLD });
    await f.service.tick();
    expect(f.writes).toEqual([780_000]);
    const first = await f.sessions.getLatest();
    expect(first).toMatchObject({ status: "ACTIVE", baselineBudgetMinor: 780_000, baselineFingerprint: "b".repeat(64),
      operationId: null, lastOutcome: "APPLIED_VERIFIED" });

    f.refresh(60_000, { spendMinor: 624_000, aggregateSpendMinor: 626_000, providerSpendObservedAt: first?.lastVerifiedAt });
    await f.service.tick();
    expect(f.writes).toEqual([780_000]);
    expect((await f.service.status(true, OWNER)).blockers).toContain("SPEND_UPDATE_PENDING");

    f.refresh(0, { providerSpendObservedAt: "2026-11-07T14:14:30.000Z" });
    await f.service.tick();
    expect(f.writes).toEqual([780_000, 936_000]);
    expect(await f.sessions.getLatest()).toMatchObject({ status: "ACTIVE", baselineBudgetMinor: 936_000, baselineFingerprint: "c".repeat(64),
      operationId: null, lastOutcome: "APPLIED_VERIFIED" });
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    expect(f.lineOutbox.size).toBe(2);
  });

  it.each([
    { event: "exact campaign missing", discovered: null, changes: {}, reason: "CAMPAIGN_ENDED" },
    { event: "another campaign visible", discovered: OTHER_ROOM, changes: {}, reason: "CAMPAIGN_ENDED" },
    { event: "provider confirms not LIVE", discovered: CAMPAIGN, changes: { liveDeliveryState: "NOT_LIVE" }, reason: "LIVE_ENDED" },
    { event: "a different LIVE room", discovered: CAMPAIGN, changes: { liveSessionId: OTHER_ROOM }, reason: "LIVE_ENDED" },
  ] as const)("stops without a write if $event", async ({ discovered, changes, reason }) => {
    const f = fixture();
    await f.arm();
    f.discover.mockResolvedValue(discovered);
    f.refresh(0, changes);
    await f.service.tick();
    expect(await f.sessions.getLatest()).toMatchObject({ status: "STOPPED", stopReason: reason });
    expect(f.ledger.create).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("holds rather than ending a session when a not-LIVE signal is unverified", async () => {
    const f = fixture();
    await f.arm();
    f.refresh(0, { liveDeliveryState: "NOT_LIVE", deliveryVerified: false, spendMinor: ORIGINAL_THRESHOLD });
    await f.service.tick();
    expect(f.writes).toEqual([]);
    expect(await f.sessions.getLatest()).toMatchObject({ status: "ACTIVE", operationId: null });
  });

  it("does not issue a new operation or replay an ambiguous provider send", async () => {
    const f = fixture();
    f.dispatch.mockImplementationOnce(async input => {
      if (!await input.canSend(f.readContext())) return { outcome: "NOT_SENT" };
      throw new Error("simulated lost provider reply");
    });
    await f.arm();
    await f.service.tick();
    const blocked = await f.sessions.getLatest();
    expect(blocked).toMatchObject({ status: "BLOCKED", operationId: expect.any(String), lastOutcome: "OUTCOME_UNKNOWN" });
    f.refresh(60_000, { providerSpendObservedAt: "2026-11-07T14:14:30.000Z" });
    await f.service.tick();
    await f.service.tick();
    expect(await f.sessions.getLatest()).toEqual(blocked);
    expect((await f.service.status(true, OWNER)).canArm).toBe(false);
    expect(f.ledger.create).toHaveBeenCalledTimes(1);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.lineOutbox.size).toBe(0);
  });
});

const unverified = { nativeAutoState: "UNKNOWN", providerSpendObservedAt: null, deliveryVerified: false, liveDeliveryState: "UNKNOWN", liveSessionId: null } as const;
describe("Ppan opted-in spend-trend Auto", () => {
  it("waits for two minute reads and repeats only after a new increase following exact provider readback", async () => {
    const f = fixture("live", "spend-trend");
    f.refresh(0, unverified);
    expect(await f.service.status(true, OWNER)).toMatchObject({ evidenceMode: "spend-trend", canArm: true, blockers: [] });
    await f.arm();
    expect(await f.sessions.getLatest()).toMatchObject({ liveSessionId: null, nativeAutoOffAttested: false, noConcurrentChangesAttested: false });
    f.refresh(60_000);
    await f.service.tick();
    f.refresh(60_000);
    await f.service.tick();
    f.refresh(0, { spendMinor: ORIGINAL_THRESHOLD + 1 });
    await f.service.tick();
    expect(f.writes).toEqual([]);
    f.refresh(60_000, { spendMinor: ORIGINAL_THRESHOLD + 2 });
    await f.service.tick();
    expect(f.writes).toEqual([780_000]);
    expect(f.dispatch.mock.calls[0][0]).toMatchObject({ evidenceMode: "spend-trend" });
    expect(f.dispatch.mock.calls[0][0]).not.toHaveProperty("nativeAutoOff");
    f.refresh(60_000, { spendMinor: 624_000, aggregateSpendMinor: 626_000 });
    await f.service.tick();
    expect(f.writes).toEqual([780_000]);
    f.refresh(60_000, { spendMinor: 624_001 });
    await f.service.tick();
    expect(f.writes).toEqual([780_000, 936_000]);
    expect(f.lineOutbox.size).toBe(2);
  });

  it("holds when a confirmed other Auto system appears and stops for a missing campaign", async () => {
    const f = fixture("live", "spend-trend");
    f.refresh(0, { ...unverified, nativeAutoState: "ENABLED" });
    await expect(f.arm()).rejects.toMatchObject({ code: "AUTO_BUDGET_NOT_READY" });
    f.refresh(0, unverified);
    await f.arm();
    f.refresh(60_000);
    await f.service.tick();
    f.refresh(60_000, { spendMinor: ORIGINAL_THRESHOLD + 1, nativeAutoState: "ENABLED" });
    await f.service.tick();
    expect(f.writes).toEqual([]);
    f.discover.mockResolvedValue(null);
    await f.service.tick();
    expect(await f.sessions.getLatest()).toMatchObject({ status: "STOPPED", stopReason: "CAMPAIGN_ENDED" });
  });

  it("adopts a separately changed budget, but never writes above the cap", async () => {
    const f = fixture("live", "spend-trend");
    f.refresh(0, unverified);
    await f.arm();
    f.refresh(60_000, { budgetMinor: 800_000, fingerprint: "e".repeat(64), spendMinor: 640_000, aggregateSpendMinor: 650_000 });
    await f.service.tick();
    expect(f.writes).toEqual([]);
    expect(await f.sessions.getLatest()).toMatchObject({ status: "ACTIVE", baselineBudgetMinor: 800_000 });
    f.refresh(60_000, { spendMinor: 640_001 });
    await f.service.tick();
    expect(f.writes).toEqual([960_000]);
    f.refresh(60_000, { spendMinor: 768_000, aggregateSpendMinor: 780_000 });
    await f.service.tick();
    f.refresh(60_000, { spendMinor: 768_001 });
    await f.service.tick();
    expect(f.writes).toEqual([960_000]);
  });
});
