import { describe, expect, it, vi } from "vitest";
import { createCreatorContinuousAutoBudgetService } from "./creatorContinuousAutoBudget.service";
import type { CreatorContinuousAutoBudgetSession, createCreatorContinuousAutoBudgetStore } from "./creatorContinuousAutoBudget.store";
import { LIVE_ROOM_SPEND_TREND, VERIFIED_ROOM_CREATOR_IDS, type ContinuousCreatorBudgetScope, type ContinuousEvidence } from "./creatorBudgetScope";
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

function fixture(mode: "shadow" | "live" = "live", evidence: ContinuousEvidence = "verified-room", clientId: ContinuousCreatorBudgetScope = "punpan_020", scheduled = false) {
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
  let nextReservedSpend: number | undefined;
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
      if (nextReservedSpend !== undefined) { context = { ...context, spendMinor: nextReservedSpend }; nextReservedSpend = undefined; }
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
      return session = { ...input, evidenceMode: input.evidenceMode ?? "verified-room", clientId, status: "ACTIVE", authorizedAt: ts(clock),
        operationId: null, lastOutcome: null, lastVerifiedAt: null, stopReason: null };
    }),
    adoptBaseline: vi.fn(async (prior, next) => session?.sessionId === prior.sessionId && session.status === "ACTIVE" && !session.operationId
      ? save({ baselineBudgetMinor: next.budgetMinor, baselineFingerprint: next.fingerprint }) : null),
    bindLiveSession: vi.fn(async (prior, liveSessionId) => session?.sessionId === prior.sessionId && session.status === "ACTIVE" && !session.operationId && session.liveSessionId === null
      ? save({ liveSessionId }) : null),
    reserve: vi.fn(async (prior, id) => session && session.sessionId === prior.sessionId && session.status === "ACTIVE" && !session.operationId
      ? save({ operationId: id, lastOutcome: null }) : null),
    isReserved: vi.fn(async (prior, id) => isPending(prior, id) && session?.status === "ACTIVE"),
    markUnknown: vi.fn(async (prior, id) => isPending(prior, id) ? save({ status: "BLOCKED", lastOutcome: "OUTCOME_UNKNOWN" }) : null),
    settleVerified: vi.fn(async (prior, id, next) => isPending(prior, id) ? save({ operationId: null,
      baselineBudgetMinor: next.budgetMinor, baselineFingerprint: next.fingerprint, lastOutcome: "APPLIED_VERIFIED", lastVerifiedAt: ts(clock) }) : null),
    settleNotSent: vi.fn(async (prior, id) => isPending(prior, id) ? save({ ...(prior.evidenceMode === "spend-trend" && session?.status === "ACTIVE" &&
      records.get(id)?.status === "NOT_SENT" ? {} : { status: "STOPPED" as const, stopReason: "NOT_SENT" as const }),
      operationId: null, lastOutcome: "NOT_SENT" }) : null),
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
    ...(scheduled ? { readPreArmContext: vi.fn(async () => ({ campaignId: CAMPAIGN, observedAt: context.observedAt, reportingDate: context.reportingDate,
      budgetMinor: context.budgetMinor, fingerprint: context.fingerprint, nativeAutoState: context.nativeAutoState,
      scheduleStartAt: "2026-11-07T14:16:00.000Z", scheduleEndAt: null })) } : {}),
    acquireLease: vi.fn(async operationId => ({ ...policy, locked: true, operationId, expiresAt: ts(clock + 60_000) })),
    finishLease: vi.fn(async (operationId, outcome) => { if (outcome === "APPLIED_VERIFIED") lineOutbox.add(operationId); }),
    dispatch,
  };
  const discover = vi.fn<() => Promise<string | null>>(async () => CAMPAIGN);
  const observe = vi.fn(async (_tick: unknown) => {});
  const legacyBusy = vi.fn(async () => false);
  const now = () => new Date(clock);
  const writer = createCreatorWebBudgetService({ clientId, store: ledger, adapters, mode: () => "live", now });
  const service = createCreatorContinuousAutoBudgetService({ clientId, mode: () => mode, discover, adapters, sessions, writer,
    ledger, recheckOwner: async (owner, authorizedAt) => owner === OWNER && authorizedAt === session?.authorizedAt,
    legacyBusy, evidenceMode: () => evidence, observeTick: observe, now });
  return { service, sessions, discover, dispatch, ledger, adapters, legacyBusy, writes, lineOutbox, observe, readContext: () => context,
    armWaiting: () => service.arm(OWNER, { ...CONFIRM, expectedLiveSessionId: null, evidenceMode: LIVE_ROOM_SPEND_TREND }, async () => true),
    setPolicy: (changes: Partial<WebBudgetPolicy>) => { policy = { ...policy, ...changes }; },
    nextReservedSpend: (spend: number) => { nextReservedSpend = spend; },
    arm: () => service.arm(OWNER, evidence === "spend-trend" ? { expectedCampaignId: CAMPAIGN, expectedBudgetMinor: ORIGINAL_BUDGET,
      expectedPolicyRevision: CAP_REVISION, evidenceMode: evidence } : evidence === LIVE_ROOM_SPEND_TREND ? { ...CONFIRM, evidenceMode: evidence } : CONFIRM, async () => true),
    refresh: (deltaMs = 0, changes: Partial<WebBudgetContext> = {}) => {
      clock += deltaMs;
      context = { ...context, observedAt: ts(clock), ...changes };
      policy = { ...policy, readAt: ts(clock) };
    },
  };
}

describe("Ppan continuous budget automation", () => {
  it.each(["ashopbytheta", "bubpa_shop189"] as const)("pre-arms %s without LIVE or spend and writes only after two verified readings from a new room", async client => {
    const f = fixture("live", LIVE_ROOM_SPEND_TREND, client, true);
    vi.mocked(f.adapters.readContext).mockRejectedValueOnce(new Error("no daily spend report"));
    expect(await f.service.status(true, OWNER)).toMatchObject({ canArm: true, preview: { waitingForLive: true, liveSessionId: null, spendMinor: null } });
    await expect(f.armWaiting()).resolves.toMatchObject({ waitingForLive: true });
    expect((await f.service.status(true, OWNER, "summary")).continuousSession).toMatchObject({ waitingForLive: true, status: "ARMED" });
    f.refresh(60_000, { liveDeliveryState: "NOT_LIVE", deliveryVerified: true, liveSessionId: null });
    vi.mocked(f.adapters.readContext).mockRejectedValueOnce(new Error("scheduled future"));
    await f.service.tick();
    f.refresh(60_000, { liveDeliveryState: "LIVE", liveSessionId: OTHER_ROOM, liveSessionStartedAt: "2026-11-07T13:10:00.000Z" });
    await f.service.tick();
    expect(f.sessions.bindLiveSession).not.toHaveBeenCalled();
    expect(f.ledger.create).not.toHaveBeenCalled();
    f.refresh(60_000, { liveSessionId: ROOM, liveSessionStartedAt: "2026-11-07T14:16:30.000Z" });
    await f.service.tick();
    expect(f.sessions.bindLiveSession).toHaveBeenCalledTimes(1);
    expect(f.dispatch).not.toHaveBeenCalled();
    f.refresh(60_000, { spendMinor: ORIGINAL_THRESHOLD + 500 });
    await f.service.tick();
    expect(f.writes).toEqual([780_000]);
    expect(f.lineOutbox.size).toBe(1);
  });
  it("refuses scheduling outside the two scopes or with a low cap; stops a pending round when settings change", async () => {
    await expect(fixture("live", LIVE_ROOM_SPEND_TREND, "myushop4", true).armWaiting()).rejects.toMatchObject({ code: "AUTO_BUDGET_NOT_READY" });
    const f = fixture("live", LIVE_ROOM_SPEND_TREND, "bubpa_shop189", true);
    f.refresh(0, { liveDeliveryState: "UNKNOWN", deliveryVerified: false, liveSessionId: null });
    f.setPolicy({ clientDailyCapMinor: ORIGINAL_BUDGET });
    expect(await f.service.status(true, OWNER)).toMatchObject({ canArm: false, blockers: ["SCHEDULED_CAP_TOO_LOW"] });
    await expect(f.armWaiting()).rejects.toMatchObject({ code: "AUTO_BUDGET_NOT_READY" });
    f.setPolicy({ clientDailyCapMinor: 1_100_000 });
    await f.armWaiting();
    f.refresh(60_000, { fingerprint: "c".repeat(64) });
    await f.service.tick();
    expect(await f.sessions.getLatest()).toMatchObject({ status: "STOPPED", stopReason: "BASELINE_CHANGED" });
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it.each(VERIFIED_ROOM_CREATOR_IDS)("requires the exact room plus a rising spend pair and attestation for %s", async clientId => {
    const f = fixture("live", LIVE_ROOM_SPEND_TREND, clientId);
    f.refresh(0, { providerSpendObservedAt: null, nativeAutoState: "UNKNOWN", liveDeliveryState: "UNKNOWN", deliveryVerified: false, liveSessionId: null });
    expect(await f.service.status(true, OWNER)).toMatchObject({ clientId, canArm: false, blockers: ["LIVE_DELIVERY_UNVERIFIED"] });
    await expect(f.arm()).rejects.toMatchObject({ code: "AUTO_BUDGET_NOT_READY" });
    await expect(fixture("live", "spend-trend", clientId).arm()).rejects.toMatchObject({ code: "AUTO_BUDGET_NOT_READY" });
    expect(f.dispatch).not.toHaveBeenCalled();
    f.refresh(0, { liveDeliveryState: "LIVE", deliveryVerified: true, liveSessionId: ROOM });
    await expect(f.service.arm(OWNER, CONFIRM, async () => true)).rejects.toMatchObject({ code: "AUTO_BUDGET_NOT_READY" });
    await expect(f.arm()).resolves.toMatchObject({ sessionId: expect.any(String) });
    f.refresh(60_000);
    await f.service.tick();
    f.refresh(60_000);
    await f.service.tick();
    expect(f.dispatch).not.toHaveBeenCalled();
    f.refresh(60_000, { spendMinor: ORIGINAL_THRESHOLD + 500 });
    await f.service.tick();
    expect(f.writes).toEqual([780000]);
    expect(f.lineOutbox.size).toBe(1);
    expect(f.dispatch).toHaveBeenCalledWith(expect.objectContaining({ evidenceMode: LIVE_ROOM_SPEND_TREND, nativeAutoOff: true, source: "auto" }));
  });
  it("does not carry a rising pair past a lost room, a room switch, or native Auto conflict", async () => {
    const f = fixture("live", LIVE_ROOM_SPEND_TREND, "bubpa_shop189");
    await f.arm();
    f.refresh(60_000); await f.service.tick();
    f.refresh(60_000, { spendMinor: ORIGINAL_THRESHOLD + 500, nativeAutoState: "ENABLED" }); await f.service.tick();
    f.refresh(60_000, { nativeAutoState: "UNKNOWN", spendMinor: ORIGINAL_THRESHOLD + 1000 }); await f.service.tick();
    f.refresh(60_000, { deliveryVerified: false, liveSessionId: null, spendMinor: ORIGINAL_THRESHOLD + 1500 }); await f.service.tick();
    f.refresh(60_000, { deliveryVerified: true, liveSessionId: OTHER_ROOM, spendMinor: ORIGINAL_THRESHOLD + 2000 }); await f.service.tick();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(await f.sessions.getLatest()).toMatchObject({ stopReason: "LIVE_ENDED", status: "STOPPED" });
  });
  it("summarizes only the operator's continuous ledger and never checks TikTok or preflights", async () => {
    const f = fixture("live");
    expect(await f.service.status(false, OWNER, "summary")).toMatchObject({ overviewState: null, continuousSession: null });
    expect(await f.service.status(true, undefined, "summary")).toMatchObject({ overviewState: null, continuousSession: null });
    expect(f.sessions.getLatest).not.toHaveBeenCalled();
    expect(await f.service.status(true, OWNER, "summary")).toMatchObject({ overviewState: "off", preview: null, canArm: false });
    vi.mocked(f.sessions.getLatest).mockRejectedValueOnce(new Error("unavailable"));
    expect(await f.service.status(true, OWNER, "summary")).toMatchObject({ overviewState: null, continuousSession: null });
    const { sessionId } = await f.arm();
    const row = (await f.sessions.getLatest())!;
    const forbidden = [f.discover, f.adapters.readContext, f.adapters.readPolicy, f.ledger.hasFence, f.legacyBusy, f.dispatch].map(x => vi.mocked(x));
    forbidden.forEach(mock => mock.mockClear());
    expect(await f.service.status(true, OWNER, "summary")).toMatchObject({ overviewState: "on", continuousSession: { sessionId, status: "ARMED" } });
    expect(await f.service.status(true, OWNER + 1, "summary")).toMatchObject({ overviewState: null, continuousSession: null, canStop: false });
    vi.mocked(f.sessions.getLatest).mockResolvedValueOnce({ ...row, operationId: sessionId });
    expect(await f.service.status(true, OWNER, "summary")).toMatchObject({ overviewState: "pending", continuousSession: { status: "SENDING" } });
    vi.mocked(f.sessions.getLatest).mockResolvedValueOnce({ ...row, status: "BLOCKED", operationId: sessionId, lastOutcome: "OUTCOME_UNKNOWN" });
    expect(await f.service.status(true, OWNER, "summary")).toMatchObject({ overviewState: "blocked", continuousSession: { status: "BLOCKED" } });
    await f.service.stop(OWNER, sessionId);
    expect(await f.service.status(true, OWNER, "summary")).toMatchObject({ overviewState: "off", continuousSession: { status: "STOPPED" } });
    forbidden.forEach(mock => expect(mock).not.toHaveBeenCalled());
    expect(await f.service.status(true, OWNER)).not.toHaveProperty("overviewState");
    expect(f.discover).toHaveBeenCalledTimes(1);
  });

  it("shows a shadow preview but cannot arm even with positive provider evidence", async () => {
    const f = fixture("shadow");
    expect(await f.service.status(true, OWNER, "summary")).toMatchObject({ overviewState: "off", preview: null });
    expect(f.discover).not.toHaveBeenCalled();
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
  it("reports actual loop reasons and missing reads without changing write eligibility", async () => {
    const f = fixture("live", "spend-trend");
    f.refresh(0, unverified);
    await f.service.tick();
    expect(f.observe).toHaveBeenLastCalledWith(expect.objectContaining({ reason: "NOT_ARMED", sessionId: null }));
    await f.arm();
    f.refresh(60_000);
    await f.service.tick();
    expect(f.observe).toHaveBeenLastCalledWith(expect.objectContaining({ reason: "SPEND_TREND_PENDING", lastValidReadAt: expect.any(String) }));
    f.discover.mockRejectedValueOnce(new Error("test timeout"));
    await expect(f.service.tick()).rejects.toThrow("test timeout");
    expect(f.observe).toHaveBeenLastCalledWith(expect.objectContaining({ reason: "CONTEXT_UNAVAILABLE", lastValidReadAt: null }));
    expect(f.dispatch).not.toHaveBeenCalled();
  });
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

  it("handles mixed provider replicas and only tries again after a new pair following proven no-send", async () => {
    const f = fixture("live", "spend-trend");
    f.refresh(0, unverified);
    await f.arm();
    f.refresh(60_000);
    await f.service.tick();
    f.refresh(60_000, { spendMinor: ORIGINAL_THRESHOLD + 30 });
    f.nextReservedSpend(ORIGINAL_THRESHOLD);
    await f.service.tick();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(await f.sessions.getLatest()).toMatchObject({ status: "ACTIVE", lastOutcome: "NOT_SENT", operationId: null });
    expect(f.ledger.finish).toHaveBeenCalledWith(OWNER, expect.any(String), expect.objectContaining({ reason: "PPAN_TREND_PREFLIGHT_SIGNAL" }));

    f.refresh(60_000, { spendMinor: ORIGINAL_THRESHOLD + 10 });
    await f.service.tick();
    expect(f.writes).toEqual([]);
    f.refresh(60_000, { spendMinor: ORIGINAL_THRESHOLD + 30 });
    f.nextReservedSpend(ORIGINAL_THRESHOLD + 20);
    await f.service.tick();
    expect(f.writes).toEqual([780_000]);
    expect(f.lineOutbox.size).toBe(1);
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
