import { describe, expect, it, vi } from "vitest";
import { createCreatorContinuousAutoBudgetService } from "./creatorContinuousAutoBudget.service";
import type { CreatorContinuousAutoBudgetSession, createCreatorContinuousAutoBudgetStore } from "./creatorContinuousAutoBudget.store";
import { configuredCreatorAutoBudgetMode, configuredCreatorScheduledAutoLive, LIVE_ROOM_SPEND_TREND, VERIFIED_ROOM_CREATOR_IDS,
  type ContinuousCreatorBudgetScope, type ContinuousEvidence } from "./creatorBudgetScope";
import { createCreatorWebBudgetService, type WebBudgetAdapters, type WebBudgetContext, type WebBudgetPolicy,
  type WebBudgetRecord, type WebBudgetStore } from "./creatorWebBudget.service";

const OWNER = 123;
const CAMPAIGN = "1234567890123456";
const ROOM = "2234567890123456";
const OTHER_ROOM = "3234567890123456";
const THIRD_ROOM = "4234567890123456";
const SETTINGS = "d".repeat(64);
const NON_ROI_SETTINGS = "c".repeat(64);
const ORIGINAL_BUDGET = 650_000;
const ORIGINAL_THRESHOLD = 520_000;
const CAP_REVISION = 7;
const CONFIRM = { expectedCampaignId: CAMPAIGN, expectedLiveSessionId: ROOM, expectedBudgetMinor: ORIGINAL_BUDGET,
  expectedPolicyRevision: CAP_REVISION, nativeAutoOff: true, noConcurrentChanges: true } as const;
const ts = (ms: number) => new Date(ms).toISOString();

function fixture(mode: "shadow" | "live" = "live", evidence: ContinuousEvidence = "verified-room", clientId: ContinuousCreatorBudgetScope = "punpan_020", scheduled = false, autoDetect = false) {
  let clock = Date.parse("2026-11-07T14:14:00.000Z");
  let session: CreatorContinuousAutoBudgetSession | null = null;
  let context: WebBudgetContext = {
    campaignId: CAMPAIGN, reportingDate: "2026-11-07", observedAt: ts(clock), budgetMinor: ORIGINAL_BUDGET,
    spendMinor: ORIGINAL_THRESHOLD, aggregateSpendMinor: ORIGINAL_THRESHOLD + 2_000, fingerprint: "a".repeat(64), settingsFingerprint: SETTINGS,
    nonRoiSettingsFingerprint: NON_ROI_SETTINGS,
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
    advanceContinuousSession: vi.fn(async (prior, next) => session?.sessionId === prior.sessionId && session.status === "ACTIVE" && !session.operationId && session.keepAutoAcrossRooms
      ? save({ liveSessionId: next.liveSessionId, lastBoundRoomStartedAt: next.lastBoundRoomStartedAt, baselineBudgetMinor: next.budgetMinor,
        baselineFingerprint: next.fingerprint, baselineSettingsFingerprint: next.settingsFingerprint,
        baselineNonRoiSettingsFingerprint: next.nonRoiSettingsFingerprint, policyRevision: next.policyRevision }) : null),
    reserve: vi.fn(async (prior, id) => session && session.sessionId === prior.sessionId && session.status === "ACTIVE" && !session.operationId
      ? save({ operationId: id, lastOutcome: null }) : null),
    isReserved: vi.fn(async (prior, id) => isPending(prior, id) && session?.status === "ACTIVE"),
    markUnknown: vi.fn(async (prior, id) => isPending(prior, id) ? save({ status: "BLOCKED", lastOutcome: "OUTCOME_UNKNOWN" }) : null),
    settleVerified: vi.fn(async (prior, id, next) => isPending(prior, id) ? save({ operationId: null,
      baselineBudgetMinor: next.budgetMinor, baselineFingerprint: next.fingerprint, lastOutcome: "APPLIED_VERIFIED", lastVerifiedAt: ts(clock) }) : null),
    settleNotSent: vi.fn(async (prior, id) => isPending(prior, id) ? save({ ...((prior.evidenceMode === "spend-trend" || prior.keepAutoAcrossRooms) && session?.status === "ACTIVE" &&
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
  const preArmContext = () => ({ campaignId: CAMPAIGN, observedAt: context.observedAt, reportingDate: context.reportingDate,
    budgetMinor: context.budgetMinor, fingerprint: context.fingerprint, settingsFingerprint: context.settingsFingerprint,
    nonRoiSettingsFingerprint: context.nonRoiSettingsFingerprint, nativeAutoState: context.nativeAutoState,
    scheduleStartAt: "2026-11-07T14:16:00.000Z", scheduleEndAt: null });
  const adapters: WebBudgetAdapters = {
    readPolicy: vi.fn(async () => policy),
    readContext: vi.fn(async () => context),
    ...(scheduled ? { readPreArmContext: vi.fn(async () => preArmContext()) } : {}),
    ...(autoDetect ? { readAutoDetectContext: vi.fn(async () => ({ ...preArmContext(), deliveryVerified: context.deliveryVerified,
      liveDeliveryState: context.liveDeliveryState, liveSessionId: context.liveSessionId, liveSessionStartedAt: context.liveSessionStartedAt,
      roomReportEmpty: context.roomReportEmpty })),
      readScheduledLiveContext: vi.fn(async () => context) } : {}),
    acquireLease: vi.fn(async operationId => ({ ...policy, locked: true, operationId, expiresAt: ts(clock + 60_000) })),
    finishLease: vi.fn(async (operationId, outcome) => { if (outcome === "APPLIED_VERIFIED") lineOutbox.add(operationId); }),
    dispatch,
  };
  const discover = vi.fn<() => Promise<string | null>>(async () => CAMPAIGN);
  const observe = vi.fn(async (_tick: unknown) => {});
  const observeCheckHealth = vi.fn(async (_tick: unknown) => {});
  const legacyBusy = vi.fn(async () => false);
  const now = () => new Date(clock);
  const writer = createCreatorWebBudgetService({ clientId, store: ledger, adapters, mode: () => "live", now });
  const service = createCreatorContinuousAutoBudgetService({ clientId, mode: () => mode, discover, adapters, sessions, writer,
    ledger, recheckOwner: async (owner, authorizedAt) => owner === OWNER && authorizedAt === session?.authorizedAt,
    legacyBusy, evidenceMode: () => evidence, ...(scheduled ? { scheduledLive: () => mode === "live" } : {}), observeTick: observe, observeCheckHealth, now });
  return { service, sessions, discover, dispatch, ledger, adapters, legacyBusy, writes, lineOutbox, observe, observeCheckHealth, readContext: () => context,
    armWaiting: () => service.arm(OWNER, { ...CONFIRM, expectedLiveSessionId: null, evidenceMode: LIVE_ROOM_SPEND_TREND }, async () => true),
    armDetecting: (room: string | null, allowExhaustedRecovery?: true) => service.arm(OWNER, { ...CONFIRM, expectedLiveSessionId: room,
      evidenceMode: LIVE_ROOM_SPEND_TREND, autoDetectLive: true, ...(allowExhaustedRecovery ? { allowExhaustedRecovery } : {}) }, async () => true),
    armPersistent: (room: string | null) => service.arm(OWNER, { ...CONFIRM, expectedLiveSessionId: room,
      evidenceMode: LIVE_ROOM_SPEND_TREND, autoDetectLive: true, allowExhaustedRecovery: true, keepAutoAcrossRooms: true }, async () => true),
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
  it("reports failed data checks independently of normal pre-LIVE, inactive and budget-ceiling holds", async () => {
    const f = fixture("live", LIVE_ROOM_SPEND_TREND, "myushop4", true, true);
    f.refresh(0, { liveSessionId: null, liveDeliveryState: "UNKNOWN", deliveryVerified: false });
    const { sessionId } = await f.armPersistent(null);
    const tick = (outcome: string) => expect(f.observeCheckHealth).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId, outcome }));
    f.refresh(60_000); vi.mocked(f.adapters.readScheduledLiveContext!).mockRejectedValueOnce(new Error("future schedule")); await f.service.tick();
    tick("NORMAL_HOLD");
    f.refresh(120_000, { roomReportEmpty: true }); await f.service.tick(); tick("NORMAL_HOLD");
    f.refresh(60_000, { roomReportEmpty: undefined }); await f.service.tick(); tick("CHECK_FAILED");
    f.refresh(60_000); f.discover.mockRejectedValueOnce(new Error("unavailable campaign API"));
    await expect(f.service.tick()).rejects.toThrow("unavailable campaign API"); tick("CHECK_FAILED");
    f.refresh(60_000); f.discover.mockResolvedValueOnce(null); await f.service.tick(); tick("NORMAL_HOLD");
    f.refresh(60_000, { liveSessionId: ROOM, liveSessionStartedAt: "2026-11-07T14:18:00.000Z", liveDeliveryState: "LIVE", deliveryVerified: true });
    vi.mocked(f.adapters.readScheduledLiveContext!).mockRejectedValueOnce(new Error("spend report unavailable")); await f.service.tick(); tick("CHECK_FAILED");
    f.setPolicy({ revision: CAP_REVISION + 1, campaignCapMinor: ORIGINAL_BUDGET, clientDailyCapMinor: ORIGINAL_BUDGET });
    f.refresh(60_000, { roomSpendMinor: 450_000 }); await f.service.tick(); tick("CHECK_VERIFIED");
    f.refresh(60_000); await f.service.tick(); tick("CHECK_VERIFIED");
    expect(await f.service.status(true, OWNER, "detect-live")).toMatchObject({ continuousSession: { status: "ARMED", reason: "CAP_REACHED" } });
    expect(f.dispatch).not.toHaveBeenCalled();
    await f.service.stop(OWNER, sessionId);
    const before = f.observeCheckHealth.mock.calls.length;
    f.refresh(60_000); await f.service.tick();
    expect(f.observeCheckHealth).toHaveBeenCalledTimes(before);
  });

  it("uses the same whole-baht round-up in verified Ppan LIVE preview, arm, and final leased write", async () => {
    const f = fixture("live", "spend-trend", "punpan_020", true, true);
    const budgetMinor = 1_289_944, targetBudgetMinor = 1_548_000;
    f.refresh(0, { budgetMinor, spendMinor: 1_049_429, aggregateSpendMinor: 1_049_429, roomSpendMinor: 900_000,
      liveSessionStartedAt: "2026-11-07T13:00:00.000Z" });
    f.setPolicy({ campaignCapMinor: targetBudgetMinor, clientDailyCapMinor: targetBudgetMinor });
    expect(await f.service.status(true, OWNER, "detect-live")).toMatchObject({ canArm: true, blockers: [],
      preview: { status: "WOULD_INCREASE", thresholdMinor: 1_031_956, currentBudgetMinor: budgetMinor, targetBudgetMinor } });
    await f.service.arm(OWNER, { ...CONFIRM, expectedBudgetMinor: budgetMinor, evidenceMode: LIVE_ROOM_SPEND_TREND,
      autoDetectLive: true, allowExhaustedRecovery: true, keepAutoAcrossRooms: true }, async () => true);
    expect(f.dispatch).not.toHaveBeenCalled();
    f.refresh(60_000); await f.service.tick();
    expect(f.dispatch).not.toHaveBeenCalled();
    f.refresh(60_000, { spendMinor: 1_059_429, aggregateSpendMinor: 1_059_429, roomSpendMinor: 910_000 }); await f.service.tick();
    expect(f.writes).toEqual([targetBudgetMinor]);
    expect(f.sessions.reserve).toHaveBeenCalledWith(expect.any(Object), expect.any(String), targetBudgetMinor, "ceil-baht");
    expect(f.adapters.acquireLease).toHaveBeenCalledWith(expect.any(String), CAP_REVISION,
      { previousBudgetMinor: budgetMinor, targetBudgetMinor, rounding: "ceil-baht" });
    expect(f.lineOutbox.size).toBe(1);
  });

  it("applies the same rounding when Ppan pre-arms without a room but still blocks below the rounded ceiling", async () => {
    const f = fixture("live", "spend-trend", "punpan_020", true, true);
    f.refresh(0, { budgetMinor: 1_289_944, liveDeliveryState: "UNKNOWN", deliveryVerified: false, liveSessionId: null });
    f.setPolicy({ campaignCapMinor: 1_547_999, clientDailyCapMinor: 1_547_999 });
    expect(await f.service.status(true, OWNER, "detect-live")).toMatchObject({ canArm: false, blockers: ["SCHEDULED_CAP_TOO_LOW"] });
    f.setPolicy({ campaignCapMinor: 1_548_000, clientDailyCapMinor: 1_548_000 });
    expect(await f.service.status(true, OWNER, "detect-live")).toMatchObject({ canArm: true, blockers: [], preview: { status: "WAITING_FOR_LIVE" } });
    await f.service.arm(OWNER, { ...CONFIRM, expectedBudgetMinor: 1_289_944, expectedLiveSessionId: null,
      evidenceMode: LIVE_ROOM_SPEND_TREND, autoDetectLive: true, keepAutoAcrossRooms: true }, async () => true);
    expect(f.ledger.create).not.toHaveBeenCalled();
  });

  it("rounds a fractional Kool budget up and uses the verified whole-baht result as the next baseline", async () => {
    const f = fixture("live", LIVE_ROOM_SPEND_TREND, "koolkool888", true, true);
    const budgetMinor = 497_664, targetBudgetMinor = 597_200;
    f.refresh(0, { budgetMinor, spendMinor: 459_404, aggregateSpendMinor: 501_011, roomSpendMinor: 423_638,
      liveSessionStartedAt: "2026-11-07T13:00:00.000Z" });
    f.setPolicy({ campaignCapMinor: 1_000_000, clientDailyCapMinor: 638_806 });
    expect(await f.service.status(true, OWNER, "detect-live")).toMatchObject({ preview: { status: "CLIENT_DAILY_CAP_EXCEEDED", targetBudgetMinor: null } });
    f.setPolicy({ clientDailyCapMinor: 1_000_000 });
    expect(await f.service.status(true, OWNER, "detect-live")).toMatchObject({ canArm: true, preview: { status: "WOULD_INCREASE", targetBudgetMinor, projectedClientSpendMinor: 638_807 } });
    await f.service.arm(OWNER, { ...CONFIRM, expectedBudgetMinor: budgetMinor, evidenceMode: LIVE_ROOM_SPEND_TREND,
      autoDetectLive: true, keepAutoAcrossRooms: true }, async () => true);
    f.refresh(60_000); await f.service.tick();
    expect(f.dispatch).not.toHaveBeenCalled();
    f.refresh(60_000, { spendMinor: 460_404, aggregateSpendMinor: 502_011, roomSpendMinor: 424_638 }); await f.service.tick();
    expect(f.writes).toEqual([targetBudgetMinor]);
    expect(await f.sessions.getLatest()).toMatchObject({ status: "ACTIVE", baselineBudgetMinor: targetBudgetMinor });
    f.refresh(60_000, { spendMinor: 478_000, aggregateSpendMinor: 519_607, roomSpendMinor: 440_000 }); await f.service.tick();
    f.refresh(60_000, { spendMinor: 479_000, aggregateSpendMinor: 520_607, roomSpendMinor: 441_000 }); await f.service.tick();
    expect(f.writes).toEqual([targetBudgetMinor, 716_700]);
    expect(f.lineOutbox.size).toBe(2);
  });

  it("keeps one authorization across three verified rooms, ignores an old room, and adopts a manual budget before any write", async () => {
    const f = fixture("live", LIVE_ROOM_SPEND_TREND, "myushop4", true, true);
    f.refresh(0, { liveSessionStartedAt: "2026-11-07T13:00:00.000Z" });
    const armed = await f.armPersistent(ROOM);
    f.refresh(60_000, { liveDeliveryState: "NOT_LIVE", liveSessionId: null }); await f.service.tick();
    expect(await f.sessions.getLatest()).toMatchObject({ sessionId: armed.sessionId, status: "ACTIVE", liveSessionId: null,
      lastBoundRoomStartedAt: "2026-11-07T13:00:00.000Z" });
    f.refresh(60_000, { liveDeliveryState: "LIVE", liveSessionId: ROOM }); await f.service.tick();
    expect(await f.sessions.getLatest()).toMatchObject({ liveSessionId: null });
    f.refresh(60_000, { liveSessionId: OTHER_ROOM, liveSessionStartedAt: "2026-11-07T14:15:00.000Z", budgetMinor: 700_000, fingerprint: "f".repeat(64) });
    await f.service.tick();
    expect(await f.sessions.getLatest()).toMatchObject({ sessionId: armed.sessionId, status: "ACTIVE", liveSessionId: OTHER_ROOM, baselineBudgetMinor: 700_000 });
    f.refresh(60_000, { liveSessionId: THIRD_ROOM, liveSessionStartedAt: "2026-11-07T14:17:00.000Z", spendMinor: 700_000,
      aggregateSpendMinor: 700_000, roomSpendMinor: 695_000 });
    await f.service.tick();
    expect(await f.sessions.getLatest()).toMatchObject({ sessionId: armed.sessionId, status: "ACTIVE", liveSessionId: THIRD_ROOM, baselineBudgetMinor: 700_000 });
    expect(f.dispatch).not.toHaveBeenCalled();
    f.refresh(60_000); await f.service.tick();
    expect(f.dispatch).not.toHaveBeenCalled();
    f.refresh(60_000); await f.service.tick();
    expect(f.writes).toEqual([840_000]); // integrated 100%, exact room, missing secondary status
    f.refresh(60_000, { liveSessionId: null, liveDeliveryState: "NOT_LIVE" }); await f.service.tick();
    expect(await f.sessions.getLatest()).toMatchObject({ sessionId: armed.sessionId, status: "ACTIVE", liveSessionId: null, lastOutcome: "APPLIED_VERIFIED" });
    await expect(f.service.stop(OWNER, armed.sessionId)).resolves.toEqual({ stopped: true });
  });

  it("pauses for an unavailable campaign or changed settings, and accepts a newly verified cap without going OFF", async () => {
    const f = fixture("live", LIVE_ROOM_SPEND_TREND, "ashopbytheta", true, true);
    f.refresh(0, { liveSessionStartedAt: "2026-11-07T13:00:00.000Z" });
    const armed = await f.armPersistent(ROOM);
    f.discover.mockResolvedValue(OTHER_ROOM);
    f.refresh(60_000); await f.service.tick();
    expect(await f.service.status(true, OWNER, "detect-live")).toMatchObject({ blockers: ["CAMPAIGN_NOT_VISIBLE"], continuousSession: { reason: "CAMPAIGN_NOT_VISIBLE" } });
    f.discover.mockResolvedValue(CAMPAIGN);
    f.refresh(60_000, { settingsFingerprint: "e".repeat(64), nonRoiSettingsFingerprint: "e".repeat(64), fingerprint: "f".repeat(64) }); await f.service.tick();
    expect((await f.service.status(true, OWNER, "detect-live")).continuousSession).toMatchObject({ reason: "CAMPAIGN_SETTINGS_CHANGED", status: "ARMED" });
    f.refresh(60_000, { settingsFingerprint: SETTINGS, nonRoiSettingsFingerprint: NON_ROI_SETTINGS, fingerprint: "a".repeat(64) });
    f.setPolicy({ revision: CAP_REVISION + 1, campaignCapMinor: ORIGINAL_BUDGET, clientDailyCapMinor: ORIGINAL_BUDGET });
    await f.service.tick();
    expect(await f.sessions.getLatest()).toMatchObject({ sessionId: armed.sessionId, status: "ACTIVE", policyRevision: CAP_REVISION + 1 });
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it.each(["punpan_020", "srihiw", "nnshop5719", "ashopbytheta", "myushop4", "bubpa_shop189", "koolkool888"] as const)(
    "keeps %s armed through pre-LIVE, ROI, budget, cap and a new room without using old spend evidence", async clientId => {
      const f = fixture("live", LIVE_ROOM_SPEND_TREND, clientId, true, true);
      f.refresh(0, { liveSessionId: null, liveDeliveryState: "UNKNOWN", deliveryVerified: false });
      const { sessionId } = await f.armPersistent(null);
      const roiSettings = "e".repeat(64), manualBudget = 700_000, target = 840_000;
      f.setPolicy({ revision: CAP_REVISION + 1, campaignCapMinor: 820_000, clientDailyCapMinor: 820_000 });
      f.refresh(60_000, { budgetMinor: manualBudget, settingsFingerprint: roiSettings, fingerprint: "f".repeat(64) });
      await f.service.tick();
      expect(await f.sessions.getLatest()).toMatchObject({ sessionId, status: "ACTIVE", liveSessionId: null, policyRevision: CAP_REVISION + 1,
        baselineBudgetMinor: manualBudget, baselineSettingsFingerprint: roiSettings, baselineNonRoiSettingsFingerprint: NON_ROI_SETTINGS });
      f.refresh(60_000, { liveSessionId: OTHER_ROOM, liveDeliveryState: "LIVE", deliveryVerified: true,
        liveSessionStartedAt: "2026-11-07T14:15:00.000Z", spendMinor: 565_000, aggregateSpendMinor: 565_000, roomSpendMinor: 550_000 });
      await f.service.tick();
      f.refresh(60_000); await f.service.tick();
      expect(f.ledger.create).not.toHaveBeenCalled();
      expect(await f.service.status(true, OWNER, "detect-live")).toMatchObject({ continuousSession: { status: "ARMED", reason: "CAP_REACHED" } });
      f.setPolicy({ revision: CAP_REVISION + 2, campaignCapMinor: 900_000, clientDailyCapMinor: 900_000 });
      f.refresh(60_000, { settingsFingerprint: SETTINGS, fingerprint: "e".repeat(64), spendMinor: 570_000, aggregateSpendMinor: 570_000, roomSpendMinor: 555_000 });
      await f.service.tick(); // adoption never sends
      f.refresh(60_000, { spendMinor: 575_000, aggregateSpendMinor: 575_000, roomSpendMinor: 560_000 }); await f.service.tick();
      expect(f.ledger.create).not.toHaveBeenCalled();
      f.refresh(60_000, { spendMinor: 580_000, aggregateSpendMinor: 580_000, roomSpendMinor: 565_000 }); await f.service.tick();
      expect(f.writes).toEqual([target]);
      expect(await f.sessions.getLatest()).toMatchObject({ sessionId, status: "ACTIVE", policyRevision: CAP_REVISION + 2, liveSessionId: OTHER_ROOM });
      await f.service.stop(OWNER, sessionId);
      f.refresh(60_000); await f.service.tick();
      expect(f.writes).toEqual([target]);
    });

  it("keeps an older active session on hold until it can independently seed the non-ROI baseline", async () => {
    const f = fixture("live", LIVE_ROOM_SPEND_TREND, "myushop4", true, true);
    f.refresh(0, { liveSessionStartedAt: "2026-11-07T13:00:00.000Z", roomSpendMinor: 500_000 });
    const { sessionId } = await f.armPersistent(ROOM);
    delete (await f.sessions.getLatest())!.baselineNonRoiSettingsFingerprint;
    f.refresh(60_000, { settingsFingerprint: "e".repeat(64), fingerprint: "f".repeat(64) }); await f.service.tick();
    expect(await f.service.status(true, OWNER, "detect-live")).toMatchObject({ blockers: ["AUTO_BASELINE_REVIEW"],
      continuousSession: { status: "ARMED", reason: "AUTO_BASELINE_REVIEW" }, canStop: true });
    expect(f.sessions.advanceContinuousSession).not.toHaveBeenCalled();
    f.refresh(60_000, { settingsFingerprint: SETTINGS, fingerprint: "a".repeat(64) }); await f.service.tick();
    expect(await f.sessions.getLatest()).toMatchObject({ sessionId, status: "ACTIVE", baselineNonRoiSettingsFingerprint: NON_ROI_SETTINGS });
    expect(f.ledger.create).not.toHaveBeenCalled();
  });

  it("keeps persistent Auto after a proven NOT_SENT preflight and starts a fresh pair", async () => {
    const f = fixture("live", LIVE_ROOM_SPEND_TREND, "ashopbytheta", true, true);
    f.refresh(0, { liveSessionStartedAt: "2026-11-07T13:00:00.000Z", roomSpendMinor: 500_000 });
    const armed = await f.armPersistent(ROOM);
    f.refresh(60_000); await f.service.tick();
    f.nextReservedSpend(ORIGINAL_THRESHOLD - 1);
    f.refresh(60_000, { spendMinor: ORIGINAL_THRESHOLD + 500, roomSpendMinor: 501_000 }); await f.service.tick();
    expect(await f.sessions.getLatest()).toMatchObject({ sessionId: armed.sessionId, status: "ACTIVE", lastOutcome: "NOT_SENT", operationId: null });
    expect(f.dispatch).not.toHaveBeenCalled();
    f.refresh(60_000, { spendMinor: ORIGINAL_THRESHOLD + 600, roomSpendMinor: 502_000 }); await f.service.tick();
    expect(f.dispatch).not.toHaveBeenCalled();
    f.refresh(60_000, { spendMinor: ORIGINAL_THRESHOLD + 900, roomSpendMinor: 503_000 }); await f.service.tick();
    expect(f.writes).toEqual([780_000]);
  });

  it.each([
    ["ENABLED", ORIGINAL_BUDGET], ["CAMPAIGN_BUDGET_EXHAUSTED", ORIGINAL_BUDGET - 1_000], [undefined, ORIGINAL_BUDGET],
  ] as const)("recovers from two flat reads when %s verifies the budget is exhausted", async (campaignDeliveryStatus, spendMinor) => {
    const f = fixture("live", LIVE_ROOM_SPEND_TREND, "bubpa_shop189", true, true);
    f.refresh(0, { liveSessionStartedAt: "2026-11-07T13:00:00.000Z", campaignDeliveryStatus,
      spendMinor, aggregateSpendMinor: spendMinor, roomSpendMinor: spendMinor - 10 });
    await f.armDetecting(ROOM, true);
    expect(await f.service.status(true, OWNER, "summary")).toMatchObject({ continuousSession: { allowExhaustedRecovery: true } });
    f.refresh(60_000); await f.service.tick();
    expect(f.dispatch).not.toHaveBeenCalled();
    f.refresh(60_000); await f.service.tick();
    expect(f.writes).toEqual([780_000]);
    expect(f.lineOutbox.size).toBe(1);
    f.refresh(60_000); await f.service.tick();
    f.refresh(60_000); await f.service.tick();
    expect(f.writes).toEqual([780_000]); // not another increase from stale exhaustion of the old amount
    f.refresh(60_000, { spendMinor: 780_000, aggregateSpendMinor: 780_000, roomSpendMinor: 779_900 }); await f.service.tick();
    f.refresh(60_000); await f.service.tick();
    expect(f.writes).toEqual([780_000, 936_000]);
  });

  it.each([
    { name: "flat 80% alone", spend: ORIGINAL_THRESHOLD, status: "ENABLED", optIn: true },
    { name: "insufficient account balance or a different delivery state", spend: ORIGINAL_BUDGET, status: "OTHER", optIn: true },
    { name: "an older consent without recovery", spend: ORIGINAL_BUDGET, status: "CAMPAIGN_BUDGET_EXHAUSTED", optIn: undefined },
    { name: "out-of-budget flag before 80%", spend: ORIGINAL_THRESHOLD - 1, status: "CAMPAIGN_BUDGET_EXHAUSTED", optIn: true },
  ] as const)("never recovers based on $name", async ({ spend, status, optIn }) => {
    const f = fixture("live", LIVE_ROOM_SPEND_TREND, "bubpa_shop189", true, true);
    f.refresh(0, { liveSessionStartedAt: "2026-11-07T13:00:00.000Z", campaignDeliveryStatus: status,
      spendMinor: spend, aggregateSpendMinor: spend, roomSpendMinor: spend - 10 });
    await f.armDetecting(ROOM, optIn);
    f.refresh(60_000); await f.service.tick();
    f.refresh(60_000); await f.service.tick();
    expect(f.ledger.create).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("keeps Auto armed but requires rising cost for a room older than 24 hours when delivery status is missing", async () => {
    const f = fixture("live", LIVE_ROOM_SPEND_TREND, "bubpa_shop189", true, true);
    f.refresh(0, { liveSessionStartedAt: "2026-11-06T13:00:00.000Z", campaignDeliveryStatus: undefined,
      spendMinor: ORIGINAL_BUDGET, aggregateSpendMinor: ORIGINAL_BUDGET, roomSpendMinor: ORIGINAL_BUDGET - 100 });
    await f.armPersistent(ROOM);
    f.refresh(60_000); await f.service.tick();
    f.refresh(60_000); await f.service.tick();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect((await f.service.status(true, OWNER, "summary")).continuousSession?.status).toBe("ARMED");
    f.refresh(60_000, { spendMinor: ORIGINAL_BUDGET + 100, aggregateSpendMinor: ORIGINAL_BUDGET + 100, roomSpendMinor: ORIGINAL_BUDGET });
    await f.service.tick();
    expect(f.writes).toEqual([780_000]);
  });

  it("does not recover if exact LIVE proof or headroom under the daily ceiling is lost", async () => {
    const f = fixture("live", LIVE_ROOM_SPEND_TREND, "bubpa_shop189", true, true);
    f.refresh(0, { liveSessionStartedAt: "2026-11-07T13:00:00.000Z", campaignDeliveryStatus: "CAMPAIGN_BUDGET_EXHAUSTED",
      spendMinor: ORIGINAL_BUDGET, aggregateSpendMinor: ORIGINAL_BUDGET, roomSpendMinor: ORIGINAL_BUDGET - 10 });
    await f.armDetecting(ROOM, true);
    f.refresh(60_000); await f.service.tick();
    f.refresh(60_000, { deliveryVerified: false, liveDeliveryState: "UNKNOWN" }); await f.service.tick();
    expect(f.ledger.create).not.toHaveBeenCalled();
    f.refresh(60_000, { deliveryVerified: true, liveDeliveryState: "LIVE", aggregateSpendMinor: 1_100_000 }); await f.service.tick();
    f.refresh(60_000); await f.service.tick();
    expect(f.ledger.create).not.toHaveBeenCalled();
  });
  it.each(["punpan_020", "srihiw", "nnshop5719", "ashopbytheta", "myushop4", "bubpa_shop189", "koolkool888"] as const)(
    "can explicitly link %s's existing LIVE even before the spend row arrives", async client => {
      const f = fixture("live", client === "punpan_020" || client === "srihiw" ? "spend-trend" : LIVE_ROOM_SPEND_TREND, client, true, true);
      f.refresh(0, { liveSessionStartedAt: "2026-11-07T13:00:00.000Z" });
      vi.mocked(f.adapters.readScheduledLiveContext!).mockRejectedValueOnce(new Error("daily spend missing"));
      expect(await f.service.status(true, OWNER, "detect-live")).toMatchObject({ canArm: true, blockers: [], preview: { status: "LIVE_WAITING_FOR_SPEND",
        autoDetectLive: true, liveSessionId: ROOM, liveSessionStartedAt: "2026-11-07T13:00:00.000Z", spendMinor: null } });
      await expect(f.armDetecting(OTHER_ROOM)).rejects.toMatchObject({ code: "AUTO_BUDGET_NOT_READY" });
      await f.armDetecting(ROOM);
      expect(await f.sessions.getLatest()).toMatchObject({ liveSessionId: ROOM, autoDetectLive: true });
      expect(f.ledger.create).not.toHaveBeenCalled();
    });

  it("polls an empty campaign, binds a verified ongoing room, and needs same-day growth of both room and campaign spend", async () => {
    const f = fixture("live", LIVE_ROOM_SPEND_TREND, "bubpa_shop189", true, true);
    f.refresh(0, { liveDeliveryState: "UNKNOWN", deliveryVerified: false, liveSessionId: null });
    expect(await f.service.status(true, OWNER, "detect-live")).toMatchObject({ canArm: true, preview: { status: "WAITING_FOR_LIVE", autoDetectLive: true } });
    await f.armDetecting(null);
    f.refresh(60_000); await f.service.tick();
    expect(f.sessions.bindLiveSession).not.toHaveBeenCalled();
    f.refresh(60_000, { liveDeliveryState: "LIVE", deliveryVerified: true, liveSessionId: ROOM, liveSessionStartedAt: "2026-11-07T13:00:00.000Z" });
    await f.service.tick();
    expect(f.sessions.bindLiveSession).toHaveBeenCalledTimes(1);
    expect(f.ledger.create).not.toHaveBeenCalled();
    f.refresh(60_000, { spendMinor: ORIGINAL_THRESHOLD + 100, roomSpendMinor: 300_000 }); await f.service.tick();
    f.refresh(60_000, { spendMinor: ORIGINAL_THRESHOLD + 200 }); await f.service.tick();
    expect(f.dispatch).not.toHaveBeenCalled();
    f.refresh(60_000, { spendMinor: ORIGINAL_THRESHOLD + 400, roomSpendMinor: 300_500 }); await f.service.tick();
    expect(f.writes).toEqual([780_000]);
    expect(f.dispatch).toHaveBeenCalledWith(expect.objectContaining({ autoDetectLive: true }));
    expect(f.lineOutbox.size).toBe(1);
    f.refresh(60_000, { liveSessionId: OTHER_ROOM }); await f.service.tick();
    expect(await f.sessions.getLatest()).toMatchObject({ status: "STOPPED", liveSessionId: ROOM });
    expect(f.sessions.bindLiveSession).toHaveBeenCalledTimes(1);
  });
  it("allows explicit NN scheduling without enabling other Creators or legacy Auto, and still requires verified manual scope", () => {
    const env = { CREATOR_READ_ENABLED: "true", CREATOR_WEB_BUDGET_LIVE_ENABLED: "true", CREATOR_AUTO_BUDGET_NNSHOP5719_MODE: "shadow",
      CREATOR_AUTO_BUDGET_NNSHOP5719_SCHEDULED_LIVE_ENABLED: "true", CREATOR_WEB_NNSHOP5719_BUDGET_MODE: "live" };
    expect(configuredCreatorScheduledAutoLive(env, "nnshop5719")).toBe(false);
    const ready = { ...env, CREATOR_WEB_NNSHOP5719_BUDGET_LIVE_ENABLED: "true" };
    expect(configuredCreatorScheduledAutoLive(ready, "nnshop5719")).toBe(true);
    expect(configuredCreatorScheduledAutoLive(ready, "srihiw")).toBe(false);
    expect(configuredCreatorAutoBudgetMode(ready, "nnshop5719")).toBe("shadow");
  });
  it("needs explicit Koolkool writer and verified-room Auto configuration without enabling any other creator", () => {
    const env = { CREATOR_READ_ENABLED: "true", CREATOR_WEB_BUDGET_LIVE_ENABLED: "true", CREATOR_WEB_KOOLKOOL888_BUDGET_MODE: "live",
      CREATOR_AUTO_BUDGET_KOOLKOOL888_MODE: "live", CREATOR_AUTO_BUDGET_KOOLKOOL888_LIVE_ENABLED: "true" };
    expect(configuredCreatorScheduledAutoLive(env, "koolkool888")).toBe(false);
    const ready = { ...env, CREATOR_WEB_KOOLKOOL888_BUDGET_LIVE_ENABLED: "true" };
    expect(configuredCreatorScheduledAutoLive(ready, "koolkool888")).toBe(true);
    expect(configuredCreatorScheduledAutoLive(ready, "bubpa_shop189")).toBe(false);
    expect(configuredCreatorScheduledAutoLive({ ...ready, CREATOR_BUDGET_TEST_ENABLED: "true" }, "koolkool888")).toBe(false);
  });
  it.each(["ashopbytheta", "bubpa_shop189", "punpan_020", "srihiw", "myushop4", "nnshop5719", "koolkool888"] as const)("pre-arms %s without LIVE or spend and writes only after two verified readings from a new room", async client => {
    const f = fixture("live", client === "punpan_020" || client === "srihiw" ? "spend-trend" : LIVE_ROOM_SPEND_TREND, client, true);
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
  it("refuses scheduling without live authorization or with a low cap; stops a pending round when settings change", async () => {
    await expect(fixture("shadow", LIVE_ROOM_SPEND_TREND, "myushop4", true).armWaiting()).rejects.toMatchObject({ code: "AUTO_BUDGET_NOT_READY" });
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
  it("explains an already-armed stale or pre-authorization room without binding or sending", async () => {
    const f = fixture("live", LIVE_ROOM_SPEND_TREND, "bubpa_shop189", true);
    await f.armWaiting();
    f.refresh(60_000, { roomEvidenceIssue: "STALE_ONGOING", liveDeliveryState: "UNKNOWN", deliveryVerified: false, liveSessionId: null });
    expect(await f.service.status(true, OWNER)).toMatchObject({ canArm: false, blockers: ["LIVE_ROOM_REPORT_STALE"], continuousSession: { waitingForLive: true } });
    await f.service.tick();
    f.refresh(60_000, { roomEvidenceIssue: undefined, liveDeliveryState: "LIVE", deliveryVerified: true, liveSessionId: ROOM,
      liveSessionStartedAt: "2026-11-07T13:50:00.000Z" });
    expect(await f.service.status(true, OWNER)).toMatchObject({ blockers: ["LIVE_ROOM_PREDATES_AUTO"] });
    await f.service.tick();
    expect(f.sessions.bindLiveSession).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("keeps the same authorized campaign through Bangkok midnight and only uses a new same-day spend pair", async () => {
    const f = fixture("live", LIVE_ROOM_SPEND_TREND, "bubpa_shop189", true);
    const readRoomContext = vi.fn(async (_campaignId: string, _roomId?: string) => f.readContext());
    f.adapters.readScheduledLiveContext = readRoomContext;
    await f.arm();
    const armed = await f.sessions.getLatest();
    f.refresh(Date.parse("2026-11-07T16:58:30.000Z") - Date.parse("2026-11-07T14:14:00.000Z"), { spendMinor: ORIGINAL_THRESHOLD });
    await f.service.tick();
    f.refresh(75_000, { spendMinor: ORIGINAL_THRESHOLD + 50 }); // 23:59:45; no time for a verified write before rollover.
    await f.service.tick();
    f.refresh(60_000, { reportingDate: "2026-11-08", liveDeliveryState: "UNKNOWN", deliveryVerified: false, liveSessionId: null });
    await f.service.tick();
    expect(await f.sessions.getLatest()).toMatchObject({ sessionId: armed?.sessionId, status: "ACTIVE", liveSessionId: ROOM });
    expect(readRoomContext).toHaveBeenCalledWith(CAMPAIGN, ROOM);
    expect(f.ledger.create).not.toHaveBeenCalled();
    f.refresh(60_000, { liveDeliveryState: "LIVE", deliveryVerified: true, liveSessionId: ROOM, spendMinor: ORIGINAL_THRESHOLD + 100 });
    await f.service.tick();
    expect(f.dispatch).not.toHaveBeenCalled();
    f.refresh(60_000, { spendMinor: ORIGINAL_THRESHOLD + 500 });
    await f.service.tick();
    expect(f.writes).toEqual([780_000]);
    expect(f.lineOutbox.size).toBe(1);
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
