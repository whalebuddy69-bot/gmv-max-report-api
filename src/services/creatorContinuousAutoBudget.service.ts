import { randomUUID } from "node:crypto";
import { allowsScheduledCreatorAuto, isContinuousCreatorBudgetScope, LIVE_ROOM_SPEND_TREND, supportsContinuousEvidence, type ContinuousEvidence } from "./creatorBudgetScope";
import { bangkokDay } from "./creatorRead.service";
import { calculateCreatorAutoBudgetTarget, previewCreatorAutoBudget } from "./creatorAutoBudget.policy";
import type { AutoBudgetOverviewState } from "./creatorAutoBudget.service";
import type { CreatorContinuousAutoBudgetClient, createCreatorContinuousAutoBudgetStore } from "./creatorContinuousAutoBudget.store";
import type { PpanAutoTickObservation, PpanAutoTickReason } from "./ppanAutoObservability.store";
import { WEB_BUDGET_CAMPAIGN_ID, WEB_BUDGET_MAX_MINOR, WebBudgetError,
  type createCreatorWebBudgetService, type WebBudgetAdapters, type WebBudgetContext, type WebBudgetPolicy, type WebBudgetPreArmContext, type WebBudgetRoomEvidence, type WebBudgetStore } from "./creatorWebBudget.service";

type Sessions = ReturnType<typeof createCreatorContinuousAutoBudgetStore>;
type Session = NonNullable<Awaited<ReturnType<Sessions["getLatest"]>>>;
type EvidenceMode = ContinuousEvidence;
type ArmInput = { expectedCampaignId: string; expectedBudgetMinor: number; expectedPolicyRevision: number } & (
  { expectedLiveSessionId: string | null; nativeAutoOff: true; noConcurrentChanges: true; evidenceMode?: typeof LIVE_ROOM_SPEND_TREND; autoDetectLive?: true; allowExhaustedRecovery?: true; keepAutoAcrossRooms?: true } |
  { evidenceMode: "spend-trend"; expectedLiveSessionId?: never; nativeAutoOff?: never; noConcurrentChanges?: never; autoDetectLive?: never; allowExhaustedRecovery?: never; keepAutoAcrossRooms?: never });
type Mode = "disabled" | "shadow" | "live";
const unavailable = () => new WebBudgetError("AUTO_BUDGET_NOT_READY", 409, "ข้อมูลสำหรับเปิด Auto ยังไม่ครบ จึงยังไม่ส่งคำสั่งจริง");
const CLIENT = "punpan_020" as const;
function instant(value: unknown) {
  if (typeof value !== "string") return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : NaN;
}
function freshContext(ctx: Pick<WebBudgetContext, "observedAt" | "reportingDate">, at: Date) {
  const readAt = instant(ctx.observedAt), age = at.getTime() - readAt;
  return age >= 0 && age <= 30_000 && ctx.reportingDate === bangkokDay(at) && bangkokDay(new Date(readAt)) === ctx.reportingDate;
}
function hasRoom<T extends WebBudgetRoomEvidence>(ctx: T): ctx is T & { liveSessionId: string } {
  return ctx.liveDeliveryState === "LIVE" && ctx.deliveryVerified === true && typeof ctx.liveSessionId === "string" && WEB_BUDGET_CAMPAIGN_ID.test(ctx.liveSessionId);
}
function spendReady(ctx: WebBudgetContext, at: Date, after?: string | null) {
  const watermark = instant(ctx.providerSpendObservedAt), age = at.getTime() - watermark;
  return age >= 0 && age <= 5 * 60_000 && watermark <= instant(ctx.observedAt) &&
    bangkokDay(new Date(watermark)) === ctx.reportingDate && (!after || watermark > instant(after));
}
const verifiedEnded = (ctx: WebBudgetRoomEvidence) => ctx.deliveryVerified === true && ctx.liveDeliveryState === "NOT_LIVE";
function confirmedExhaustion(ctx: WebBudgetContext, priorIncrease: boolean) {
  // This is the exact campaign's delivery state, never advertiser balance.
  if (ctx.campaignDeliveryStatus === "CAMPAIGN_BUDGET_EXHAUSTED") {
    // After a verified increase, a lingering provider flag may still refer
    // to the old amount. The new amount must actually be used up.
    return ctx.spendMinor >= ctx.budgetMinor || (!priorIncrease && ctx.spendMinor * 5 >= ctx.budgetMinor * 4);
  }
  // Some exact LIVE GMV Max list responses omit secondary_status entirely.
  // Without that signal, a room more than a day old must still prove rising
  // spend. A stale unfinished-room marker alone cannot recover a flat budget.
  const roomAge = instant(ctx.observedAt) - instant(ctx.liveSessionStartedAt);
  return (ctx.campaignDeliveryStatus === "ENABLED" || (ctx.campaignDeliveryStatus === undefined &&
    roomAge >= 0 && roomAge <= 86_400_000)) && ctx.spendMinor >= ctx.budgetMinor;
}
function verifiedDetectedRoom<T extends WebBudgetRoomEvidence>(ctx: T, at: Date): ctx is T & { liveSessionId: string; liveSessionStartedAt: string } {
  const launch = instant(ctx.liveSessionStartedAt);
  return hasRoom(ctx) && Number.isFinite(launch) && launch <= at.getTime();
}
function predatesWaitingAuthorization(ctx: WebBudgetContext, row: Session) {
  const launch = instant(ctx.liveSessionStartedAt), arm = instant(row.authorizedAt);
  return hasRoom(ctx) && Number.isFinite(launch) && Number.isFinite(arm) && launch < arm - 60_000;
}
function blockers(ctx: WebBudgetContext, policy: WebBudgetPolicy, fenced: boolean, at: Date, evidence: EvidenceMode, session?: Session) {
  const codes: PpanAutoTickReason[] = [];
  if (evidence === "spend-trend") {
    if (ctx.nativeAutoState !== "DISABLED" && ctx.nativeAutoState !== "UNKNOWN") codes.push("NATIVE_AUTO_CONFLICT");
    if (verifiedEnded(ctx)) codes.push("LIVE_ENDED");
  } else if (evidence === LIVE_ROOM_SPEND_TREND) {
    if (ctx.nativeAutoState !== "DISABLED" && ctx.nativeAutoState !== "UNKNOWN") codes.push("NATIVE_AUTO_CONFLICT");
    if (!hasRoom(ctx) || (session && ctx.liveSessionId !== session.liveSessionId)) codes.push("LIVE_DELIVERY_UNVERIFIED");
  } else {
    if (ctx.nativeAutoState !== "DISABLED") codes.push("NATIVE_AUTO_UNVERIFIED");
    if (!spendReady(ctx, at, session?.lastVerifiedAt)) codes.push(ctx.providerSpendObservedAt ? "SPEND_UPDATE_PENDING" : "SPEND_WATERMARK_MISSING");
    if (!hasRoom(ctx)) codes.push("LIVE_DELIVERY_UNVERIFIED");
  }
  if (policy.autoLineReady !== true) codes.push("LINE_NOT_READY");
  if (fenced || policy.locked) codes.push("WRITE_LOCKED");
  return codes;
}
function canStart(ctx: WebBudgetContext, policy: WebBudgetPolicy, fenced: boolean, at: Date, evidence: EvidenceMode, rounding?: "floor-satang") {
  if (blockers(ctx, policy, fenced, at, evidence).length) return false;
  const result = previewCreatorAutoBudget({ now: at, context: ctx, policy, rounding });
  if (result.status === "WOULD_INCREASE") return true;
  if (result.status !== "BELOW_THRESHOLD") return false;
  const next = calculateCreatorAutoBudgetTarget(ctx.budgetMinor, rounding);
  return next !== null && next <= BigInt(policy.campaignCapMinor) &&
    next + BigInt(ctx.aggregateSpendMinor - ctx.spendMinor) <= BigInt(policy.clientDailyCapMinor);
}

const validAmount = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= WEB_BUDGET_MAX_MINOR;
const validSettingsFingerprint = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
function persistentSettingsHold(ctx: Pick<WebBudgetPreArmContext, "settingsFingerprint" | "nonRoiSettingsFingerprint">, row?: Session | null) {
  if (!validSettingsFingerprint(ctx.settingsFingerprint) || !validSettingsFingerprint(ctx.nonRoiSettingsFingerprint)) return "CONTEXT_UNAVAILABLE";
  if (!row?.keepAutoAcrossRooms) return null;
  // Older armed sessions only pinned the ROI-inclusive hash. Never establish
  // the new baseline from changed, unverifiable settings for those sessions.
  if (row.baselineNonRoiSettingsFingerprint === undefined) {
    return ctx.settingsFingerprint === row.baselineSettingsFingerprint ? null : "AUTO_BASELINE_REVIEW";
  }
  return ctx.nonRoiSettingsFingerprint === row.baselineNonRoiSettingsFingerprint ? null : "CAMPAIGN_SETTINGS_CHANGED";
}
function freshPolicy(policy: WebBudgetPolicy, at: Date) {
  const age = at.getTime() - instant(policy.readAt);
  return validAmount(policy.campaignCapMinor) && validAmount(policy.clientDailyCapMinor) && Number.isSafeInteger(policy.revision) &&
    policy.revision > 0 && age >= 0 && age <= 20_000;
}
function validScheduledContext(ctx: WebBudgetPreArmContext, campaignId: string, at: Date) {
  const start = instant(ctx.scheduleStartAt), end = ctx.scheduleEndAt === null ? Infinity : instant(ctx.scheduleEndAt);
  return ctx.campaignId === campaignId && freshContext(ctx, at) && validAmount(ctx.budgetMinor) && /^[0-9a-f]{64}$/.test(ctx.fingerprint) &&
    Number.isFinite(start) && end > start && end > at.getTime();
}
function scheduledBlockers(ctx: WebBudgetPreArmContext, policy: WebBudgetPolicy, fenced: boolean, at: Date, rounding?: "floor-satang"): string[] {
  const reasons: string[] = [];
  const target = calculateCreatorAutoBudgetTarget(ctx.budgetMinor, rounding);
  if (!freshPolicy(policy, at)) reasons.push("CONTEXT_UNAVAILABLE");
  else if (target !== null && target > BigInt(Math.min(policy.campaignCapMinor, policy.clientDailyCapMinor))) reasons.push("SCHEDULED_CAP_TOO_LOW");
  if (target === null) reasons.push("SCHEDULED_TARGET_NOT_EXACT");
  if (ctx.nativeAutoState !== "DISABLED" && ctx.nativeAutoState !== "UNKNOWN") reasons.push("NATIVE_AUTO_CONFLICT");
  if (policy.autoLineReady !== true) reasons.push("LINE_NOT_READY");
  if (fenced || policy.locked) reasons.push("WRITE_LOCKED");
  return reasons;
}

export function createCreatorContinuousAutoBudgetService({ mode, discover, adapters, sessions, writer, ledger, recheckOwner, legacyBusy, observeTick,
  clientId = CLIENT, evidenceMode = () => "verified-room", scheduledLive, now = () => new Date() }: {
  mode: () => Mode; discover: () => Promise<string | null>; adapters: WebBudgetAdapters; sessions: Sessions;
  writer: ReturnType<typeof createCreatorWebBudgetService>; ledger: WebBudgetStore;
  recheckOwner: (id: number, authorizedAt: string) => Promise<boolean>; legacyBusy: () => Promise<boolean>;
  observeTick?: (event: PpanAutoTickObservation) => Promise<unknown>;
  clientId?: CreatorContinuousAutoBudgetClient; evidenceMode?: () => EvidenceMode; scheduledLive?: () => boolean; now?: () => Date;
}) {
  if (!isContinuousCreatorBudgetScope(clientId)) throw new Error("CREATOR_CONTINUOUS_AUTO_SCOPE_UNSUPPORTED");
  // The existing Ppan writer and LINE policy bridge already support flooring
  // to satang. Use it for every Ppan continuous mode, including verified LIVE.
  const rounding = clientId === CLIENT ? "floor-satang" as const : undefined;
  const canWaitForLive = () => allowsScheduledCreatorAuto(clientId) && !!adapters.readPreArmContext &&
    (scheduledLive ? scheduledLive() : evidenceMode() === LIVE_ROOM_SPEND_TREND && mode() === "live");
  const allowedEvidence = (evidence: EvidenceMode) => (mode() === "live" && evidenceMode() === evidence) ||
    (evidence === LIVE_ROOM_SPEND_TREND && canWaitForLive());
  const waiting = (row: Session | null | undefined) => row?.status === "ACTIVE" && !row.operationId && row.liveSessionId === null && row.evidenceMode === LIVE_ROOM_SPEND_TREND;
  const canAutoDetect = () => canWaitForLive() && !!adapters.readAutoDetectContext && !!adapters.readScheduledLiveContext;
  const preview = (ctx: WebBudgetContext, policy: WebBudgetPolicy, at: Date) =>
    previewCreatorAutoBudget({ now: at, context: ctx, policy, rounding });
  // Deliberately process-local. A restart or incomplete read requires a fresh
  // pair of minute polls; an old qualifying sample never survives a restart.
  let pulse: { key: string; at: number; spend: number; roomSpend?: number; exhausted: boolean } | undefined;
  let lastTick: { sessionId: string; at: number; reason: string } | undefined;
  function observeTrend(row: Session, ctx: WebBudgetContext) {
    const timestamp = instant(ctx.observedAt), anchor = Math.max(instant(row.authorizedAt), row.lastVerifiedAt ? instant(row.lastVerifiedAt) : 0);
    const roomSpend = row.autoDetectLive ? ctx.roomSpendMinor : undefined;
    if (!Number.isFinite(anchor) || timestamp <= anchor || !Number.isSafeInteger(ctx.spendMinor) || ctx.spendMinor < 0 ||
      (row.autoDetectLive && (typeof roomSpend !== "number" || !Number.isSafeInteger(roomSpend) || roomSpend < 0))) {
      pulse = undefined;
      return null;
    }
    const key = `${row.sessionId}:${ctx.reportingDate}:${ctx.fingerprint}:${anchor}:${row.evidenceMode === LIVE_ROOM_SPEND_TREND ? ctx.liveSessionId : ""}:${row.autoDetectLive ? ctx.liveSessionStartedAt : ""}`;
    const previous = pulse, gap = previous ? timestamp - previous.at : NaN;
    if (previous?.key === key && gap >= 0 && gap < 40_000 && ctx.spendMinor >= previous.spend &&
      (!row.autoDetectLive || (roomSpend ?? -1) >= (previous.roomSpend ?? Infinity))) return null;
    const exhausted = row.allowExhaustedRecovery === true && confirmedExhaustion(ctx, row.lastVerifiedAt !== null);
    pulse = { key, at: timestamp, spend: ctx.spendMinor, roomSpend, exhausted };
    if (previous?.key !== key || gap < 40_000 || gap > 95_000) return null;
    if (ctx.spendMinor > previous.spend && (!row.autoDetectLive || (roomSpend ?? -1) > (previous.roomSpend ?? Infinity))) {
      return { ...previous, kind: "rising" as const };
    }
    // Full-budget recovery is not the ordinary 80% trigger. Two fresh,
    // same-day reads must both verify exhaustion of this campaign budget;
    // real, nondecreasing cost for its same verified room corroborates it.
    if (row.autoDetectLive && row.allowExhaustedRecovery && previous.exhausted && exhausted && ctx.spendMinor >= previous.spend &&
      (previous.roomSpend ?? 0) > 0 && (roomSpend ?? -1) >= (previous.roomSpend ?? Infinity)) {
      return { ...previous, kind: "exhausted" as const };
    }
    return null;
  }
  async function read(campaignId: string, evidence: EvidenceMode, expectedLiveSessionId?: string, autoDetectLive?: true) {
    if (autoDetectLive && !adapters.readScheduledLiveContext) throw unavailable();
    const readContext = evidence === LIVE_ROOM_SPEND_TREND && adapters.readScheduledLiveContext
      ? autoDetectLive ? adapters.readScheduledLiveContext(campaignId, expectedLiveSessionId, true)
        : adapters.readScheduledLiveContext(campaignId, expectedLiveSessionId) : adapters.readContext(campaignId);
    const [context, policy, fenced] = await Promise.all([readContext, adapters.readPolicy(), ledger.hasFence()]);
    return { context, policy, fenced };
  }
  async function readScheduled(campaignId: string) {
    const [context, policy, fenced] = await Promise.all([adapters.readPreArmContext!(campaignId), adapters.readPolicy(), ledger.hasFence()]);
    return { context, policy, fenced };
  }
  async function readDetected(campaignId: string, expectedLiveSessionId?: string) {
    if (!adapters.readAutoDetectContext) throw unavailable();
    const [context, policy, fenced] = await Promise.all([adapters.readAutoDetectContext(campaignId, expectedLiveSessionId), adapters.readPolicy(), ledger.hasFence()]);
    return { context, policy, fenced };
  }

  async function trackPersistent(row: Session, campaign: string) {
    // Discover the sole corroborated current room without filtering it out
    // merely because the prior room changed. A missing report does not end it.
    const full = await read(campaign, LIVE_ROOM_SPEND_TREND, undefined, true).catch(() => null);
    const checked = full ?? await readDetected(campaign);
    const { context, policy, fenced } = checked, at = now();
    const hold = (reason: PpanAutoTickReason, detail?: string) => ({ full: null, reason, detail });
    if (!context) return hold("CAMPAIGN_ENDED", "CAMPAIGN_NOT_VISIBLE");
    if (context.campaignId !== campaign || !freshContext(context, at) || !validAmount(context.budgetMinor) ||
      !validSettingsFingerprint(context.fingerprint) || !freshPolicy(policy, at)) return hold("CONTEXT_UNAVAILABLE");
    if (context.nativeAutoState !== "DISABLED" && context.nativeAutoState !== "UNKNOWN") return hold("NATIVE_AUTO_CONFLICT");
    const { settingsFingerprint, nonRoiSettingsFingerprint } = context;
    if (!validSettingsFingerprint(settingsFingerprint) || !validSettingsFingerprint(nonRoiSettingsFingerprint)) return hold("CONTEXT_UNAVAILABLE");
    const settingsHold = persistentSettingsHold(context, row);
    if (settingsHold) return hold(settingsHold === "CONTEXT_UNAVAILABLE" ? "CONTEXT_UNAVAILABLE" : "BASELINE_CHANGED", settingsHold);
    if (fenced || policy.locked) return hold("WRITE_LOCKED");
    let room = row.liveSessionId, start = row.lastBoundRoomStartedAt;
    const current = verifiedDetectedRoom(context, at) ? context : null;
    if (current && current.liveSessionId === room && current.liveSessionStartedAt !== start) return hold("LIVE_DELIVERY_UNVERIFIED");
    if (current && current.liveSessionId !== room) {
      // Do not re-attach to a previously ended room or go back to an earlier
      // room just because TikTok is momentarily serving an old report.
      if (start && instant(current.liveSessionStartedAt) <= instant(start)) return hold("LIVE_DELIVERY_UNVERIFIED");
      room = current.liveSessionId;
      start = current.liveSessionStartedAt;
    } else if (!current && room) {
      // An unscoped END-only report can be about some other room. Only an
      // END scoped to the durable room ID is allowed to detach it.
      const prior = await readDetected(campaign, room).catch(() => null);
      if (prior?.context && validScheduledContext(prior.context, campaign, now()) &&
        prior.context.fingerprint === context.fingerprint && prior.context.settingsFingerprint === context.settingsFingerprint &&
        verifiedEnded(prior.context)) room = null;
    }
    if (room !== row.liveSessionId || start !== row.lastBoundRoomStartedAt || context.budgetMinor !== row.baselineBudgetMinor ||
      context.fingerprint !== row.baselineFingerprint || policy.revision !== row.policyRevision ||
      settingsFingerprint !== row.baselineSettingsFingerprint || nonRoiSettingsFingerprint !== row.baselineNonRoiSettingsFingerprint) {
      const advanced = await sessions.advanceContinuousSession(row, { liveSessionId: room, lastBoundRoomStartedAt: start,
        budgetMinor: context.budgetMinor, fingerprint: context.fingerprint, settingsFingerprint,
        nonRoiSettingsFingerprint, policyRevision: policy.revision });
      return advanced ? hold(room ? "SPEND_UPDATE_PENDING" : "LIVE_DELIVERY_UNVERIFIED") : hold("WRITE_LOCKED");
    }
    if (!current || !room || !full) return hold(current ? "SPEND_UPDATE_PENDING" : "LIVE_DELIVERY_UNVERIFIED");
    return { full, reason: "SPEND_UPDATE_PENDING" as const, detail: undefined };
  }

  async function status(operator: boolean, ownerId?: number, view?: "summary" | "detect-live") {
    const currentMode = canWaitForLive() ? "live" : mode();
    const readOwnerState = operator && (view !== "summary" || (typeof ownerId === "number" && Number.isSafeInteger(ownerId) && ownerId > 0));
    const state = readOwnerState ? await sessions.getLatest().then(row => ({ row, ok: true })).catch(() => ({ row: null, ok: false })) : { row: null, ok: false };
    const row = state.row, own = row?.ownerId === ownerId ? row : null;
    const visible = view === "summary" ? own : row;
    const evidence = visible && visible.status !== "STOPPED" ? visible.evidenceMode ?? "verified-room" : evidenceMode();
    const ownStatus = own?.status === "ACTIVE" ? (own.operationId ? "SENDING" : "ARMED") : own?.status;
    const recentTick = own && ownStatus === "ARMED" && own.keepAutoAcrossRooms && lastTick?.sessionId === own.sessionId &&
      now().getTime() - lastTick.at <= 180_000 ? lastTick.reason : null;
    const continuousSession = own && ownStatus ? { sessionId: own.sessionId, status: ownStatus,
      startedAt: own.authorizedAt, reason: own.stopReason ?? (own.lastOutcome === "OUTCOME_UNKNOWN" ? own.lastOutcome : recentTick),
      ...(waiting(own) ? { waitingForLive: true as const } : {}), ...(own.autoDetectLive ? { autoDetectLive: true as const } : {}),
      ...(own.allowExhaustedRecovery ? { allowExhaustedRecovery: true as const } : {}),
      ...(own.keepAutoAcrossRooms ? { keepAutoAcrossRooms: true as const } : {}) } : null;
    const base = { clientId, strategy: "continuous" as const, mode: currentMode, grant: null, continuousSession,
      ...(evidence !== "verified-room" ? { evidenceMode: evidence } : {}),
      canStop: !!own && own.status !== "STOPPED" };
    if (view === "summary") {
      let overviewState: AutoBudgetOverviewState = null;
      if (state.ok && (!row || own)) {
        if (own?.status === "BLOCKED" || (own?.operationId && own.lastOutcome === "OUTCOME_UNKNOWN")) overviewState = "blocked";
        else if (own?.operationId) overviewState = "pending";
        else if (own?.status === "ACTIVE") overviewState = currentMode === "live" ? "on" : "blocked";
        else overviewState = "off";
      }
      return { ...base, canArm: false, preview: null, blockers: [], overviewState };
    }
    if (currentMode === "disabled") return { ...base, canArm: false, preview: null, blockers: [] };
    try {
      const campaign = await discover();
      if (!campaign || (own?.status === "ACTIVE" && own.keepAutoAcrossRooms && campaign !== own.campaignId)) {
        return { ...base, canArm: false, preview: null, blockers: ["CAMPAIGN_NOT_VISIBLE"] };
      }
      const canRequest = currentMode === "live" && operator && state.ok && (!row || (row.status === "STOPPED" && !row.operationId));
      if (view === "detect-live" && canAutoDetect() && (canRequest || (own?.status === "ACTIVE" && (own.autoDetectLive || waiting(own))))) {
        const boundRoom = own?.status === "ACTIVE" ? own.liveSessionId ?? undefined : undefined;
        const exact = await read(campaign, LIVE_ROOM_SPEND_TREND, boundRoom, true).catch(() => null);
        const at = now();
        const expected = (ctx: WebBudgetRoomEvidence) => !boundRoom || boundRoom === ctx.liveSessionId;
        if (exact && freshContext(exact.context, at) && verifiedDetectedRoom(exact.context, at) && expected(exact.context)) {
          const { context, policy, fenced } = exact;
          const verdict = preview(context, policy, at);
          const reasons: string[] = blockers(context, policy, fenced, at, LIVE_ROOM_SPEND_TREND);
          const settingsHold = persistentSettingsHold(context, own?.status === "ACTIVE" ? own : null);
          if (settingsHold) reasons.push(settingsHold);
          if (boundRoom && verdict.status === "WOULD_INCREASE" && !reasons.length) reasons.push("SPEND_TREND_PENDING");
          return { ...base, evidenceMode: LIVE_ROOM_SPEND_TREND,
            canArm: canRequest && !reasons.length && canStart(context, policy, fenced, at, LIVE_ROOM_SPEND_TREND, rounding) && !await legacyBusy(), blockers: reasons,
            preview: { status: verdict.status, autoDetectLive: true as const, allowExhaustedRecovery: true as const, keepAutoAcrossRooms: true as const, campaignId: campaign, currentBudgetMinor: context.budgetMinor,
              liveSessionId: context.liveSessionId, liveSessionStartedAt: context.liveSessionStartedAt, spendMinor: context.spendMinor, policyRevision: policy.revision,
              thresholdMinor: Number((BigInt(context.budgetMinor) * 8n + 9n) / 10n), targetBudgetMinor: verdict.status === "WOULD_INCREASE" ? verdict.targetBudgetMinor : null,
              projectedClientSpendMinor: verdict.status === "WOULD_INCREASE" ? verdict.projectedClientSpendMinor : null, observedAt: context.observedAt } };
        }
        const { context, policy, fenced } = await readDetected(campaign, boundRoom), checkedAt = now();
        if (!context || !validScheduledContext(context, campaign, checkedAt)) return { ...base, canArm: false, preview: null, blockers: ["CONTEXT_UNAVAILABLE"] };
        const reasons = scheduledBlockers(context, policy, fenced, checkedAt, rounding);
        const settingsHold = persistentSettingsHold(context, own?.status === "ACTIVE" ? own : null);
        if (settingsHold && !reasons.includes(settingsHold)) reasons.push(settingsHold);
        const matched = verifiedDetectedRoom(context, checkedAt) && expected(context) ? context : null;
        if (!matched && boundRoom) reasons.push("LIVE_DELIVERY_UNVERIFIED");
        if (!matched && context.roomEvidenceIssue === "STALE_ONGOING" && !canRequest) reasons.push("LIVE_ROOM_REPORT_STALE");
        return { ...base, evidenceMode: LIVE_ROOM_SPEND_TREND, canArm: canRequest && !reasons.length && !await legacyBusy(), blockers: reasons,
          preview: { ...(matched ? { status: "LIVE_WAITING_FOR_SPEND", liveSessionId: matched.liveSessionId, liveSessionStartedAt: matched.liveSessionStartedAt }
            : { status: "WAITING_FOR_LIVE", waitingForLive: true as const, liveSessionId: null }),
            autoDetectLive: true as const, allowExhaustedRecovery: true as const, keepAutoAcrossRooms: true as const, campaignId: campaign, currentBudgetMinor: context.budgetMinor, spendMinor: null,
            policyRevision: policy.revision, thresholdMinor: Number((BigInt(context.budgetMinor) * 8n + 9n) / 10n), targetBudgetMinor: null,
            projectedClientSpendMinor: null, observedAt: context.observedAt } };
      }
      const canReadScheduled = canWaitForLive() && (canRequest || waiting(own));
      // When offering the new authorization, do not equate historical spend with
      // a current room. Existing spend-trend rounds keep their original reads.
      const full = await read(campaign, canReadScheduled ? LIVE_ROOM_SPEND_TREND : evidence,
        row?.status === "ACTIVE" ? row.liveSessionId ?? undefined : undefined)
        .catch(error => { if (!canReadScheduled) throw error; return null; });
      if (canReadScheduled && (!full || !hasRoom(full.context) || waiting(own))) {
        const { context, policy, fenced } = await readScheduled(campaign), at = now();
        if (!context || !validScheduledContext(context, campaign, at)) return { ...base, canArm: false, preview: null, blockers: ["CONTEXT_UNAVAILABLE"] };
        const reasons = scheduledBlockers(context, policy, fenced, at, rounding);
        if (own && waiting(own) && full) {
          if (full.context.roomEvidenceIssue === "STALE_ONGOING") reasons.push("LIVE_ROOM_REPORT_STALE");
          else if (predatesWaitingAuthorization(full.context, own)) reasons.push("LIVE_ROOM_PREDATES_AUTO");
        }
        return { ...base, evidenceMode: LIVE_ROOM_SPEND_TREND, canArm: canRequest && !reasons.length && !await legacyBusy(), blockers: reasons,
          preview: { status: "WAITING_FOR_LIVE", waitingForLive: true as const, campaignId: campaign, currentBudgetMinor: context.budgetMinor,
            liveSessionId: null, spendMinor: null, policyRevision: policy.revision, thresholdMinor: Number((BigInt(context.budgetMinor) * 8n + 9n) / 10n),
            targetBudgetMinor: null, projectedClientSpendMinor: null, observedAt: context.observedAt } };
      }
      if (!full) throw unavailable();
      const { context, policy, fenced } = full, at = now();
      const selected = canRequest && !allowedEvidence(evidence) && canReadScheduled ? LIVE_ROOM_SPEND_TREND : evidence;
      const verdict = preview(context, policy, at);
      const canArm = canRequest && allowedEvidence(selected) &&
        canStart(context, policy, fenced, at, selected, rounding) && !await legacyBusy();
      const reasons = blockers(context, policy, fenced, at, selected, row?.status === "ACTIVE" ? row : undefined);
      if (selected !== "verified-room" && row?.status === "ACTIVE" && !row.operationId && verdict.status === "WOULD_INCREASE" && !reasons.length) reasons.push("SPEND_TREND_PENDING");
      return { ...base, ...(selected !== "verified-room" ? { evidenceMode: selected } : {}), canArm, preview: { status: verdict.status, campaignId: context.campaignId, currentBudgetMinor: context.budgetMinor,
        liveSessionId: hasRoom(context) ? context.liveSessionId : null,
        spendMinor: context.spendMinor, policyRevision: policy.revision, thresholdMinor: Number((BigInt(context.budgetMinor) * 8n + 9n) / 10n),
        targetBudgetMinor: verdict.status === "WOULD_INCREASE" ? verdict.targetBudgetMinor : null,
        projectedClientSpendMinor: verdict.status === "WOULD_INCREASE" ? verdict.projectedClientSpendMinor : null,
        observedAt: context.observedAt }, blockers: reasons };
    } catch { return { ...base, canArm: false, preview: null, blockers: ["CONTEXT_UNAVAILABLE"] }; }
  }

  async function arm(ownerId: number, input: ArmInput, recheckOperator: () => Promise<boolean>) {
    const evidence = input.evidenceMode === LIVE_ROOM_SPEND_TREND ? LIVE_ROOM_SPEND_TREND : evidenceMode();
    const trend = input.evidenceMode === "spend-trend";
    const autoDetectLive = input.autoDetectLive === true;
    const allowExhaustedRecovery = input.allowExhaustedRecovery === true;
    const keepAutoAcrossRooms = input.keepAutoAcrossRooms === true;
    let lastBoundRoomStartedAt: string | undefined;
    const wait = input.expectedLiveSessionId === null && evidence === LIVE_ROOM_SPEND_TREND && canWaitForLive();
    if (!allowedEvidence(evidence) || !supportsContinuousEvidence(clientId, evidence) || !WEB_BUDGET_CAMPAIGN_ID.test(input.expectedCampaignId) ||
      (input.autoDetectLive !== undefined && (!autoDetectLive || evidence !== LIVE_ROOM_SPEND_TREND || !canAutoDetect())) ||
      (input.allowExhaustedRecovery !== undefined && (!allowExhaustedRecovery || !autoDetectLive)) ||
      (input.keepAutoAcrossRooms !== undefined && (!keepAutoAcrossRooms || !autoDetectLive)) ||
      input.evidenceMode !== (evidence === "verified-room" ? undefined : evidence) ||
      (trend ? input.expectedLiveSessionId !== undefined || input.nativeAutoOff !== undefined || input.noConcurrentChanges !== undefined
        : (!wait && (typeof input.expectedLiveSessionId !== "string" || !WEB_BUDGET_CAMPAIGN_ID.test(input.expectedLiveSessionId))) ||
          input.nativeAutoOff !== true || input.noConcurrentChanges !== true) || await legacyBusy()) throw unavailable();
    const campaignId = await discover();
    if (!campaignId || campaignId !== input.expectedCampaignId) throw unavailable();
    const ready = autoDetectLive ? await readDetected(campaignId, input.expectedLiveSessionId ?? undefined).then(({ context, policy, fenced }) => {
      const at = now();
      if (!context || !validScheduledContext(context, campaignId, at) || scheduledBlockers(context, policy, fenced, at, rounding).length ||
        (keepAutoAcrossRooms && persistentSettingsHold(context))) return null;
      if (!wait) {
        if (!verifiedDetectedRoom(context, at) || context.liveSessionId !== input.expectedLiveSessionId) return null;
        lastBoundRoomStartedAt = context.liveSessionStartedAt;
      }
      return { context, policy };
    }) : wait ? await readScheduled(campaignId).then(({ context, policy, fenced }) => {
      const at = now();
      return context && validScheduledContext(context, campaignId, at) && !scheduledBlockers(context, policy, fenced, at, rounding).length ? { context, policy } : null;
    }) : await read(campaignId, evidence).then(({ context, policy, fenced }) =>
      (trend || hasRoom(context) && context.liveSessionId === input.expectedLiveSessionId) && canStart(context, policy, fenced, now(), evidence, rounding)
        ? { context, policy } : null);
    if (!ready || ready.context.campaignId !== campaignId || ready.context.budgetMinor !== input.expectedBudgetMinor ||
      ready.policy.revision !== input.expectedPolicyRevision || !await recheckOperator() || !allowedEvidence(evidence)) throw unavailable();
    const { context, policy } = ready;
    const row = await sessions.arm({ sessionId: randomUUID(), ownerId, campaignId,
      policyRevision: policy.revision, baselineBudgetMinor: context.budgetMinor, baselineFingerprint: context.fingerprint,
      ...(trend ? { evidenceMode: "spend-trend" as const, liveSessionId: null, nativeAutoOffAttested: false as const, noConcurrentChangesAttested: false as const }
        : { ...(evidence === LIVE_ROOM_SPEND_TREND ? { evidenceMode: evidence } : {}), liveSessionId: input.expectedLiveSessionId,
          nativeAutoOffAttested: true as const, noConcurrentChangesAttested: true as const,
          ...(autoDetectLive ? { autoDetectLive: true as const } : {}), ...(allowExhaustedRecovery ? { allowExhaustedRecovery: true as const } : {}),
          ...(keepAutoAcrossRooms ? { keepAutoAcrossRooms: true as const, baselineSettingsFingerprint: context.settingsFingerprint,
            baselineNonRoiSettingsFingerprint: context.nonRoiSettingsFingerprint,
            ...(lastBoundRoomStartedAt ? { lastBoundRoomStartedAt } : {}) } : {}) }) });
    if (!row) throw new WebBudgetError("AUTO_BUDGET_SESSION_EXISTS", 409, "มีรอบ Auto หรือรายการที่ยังต้องตรวจสอบอยู่แล้ว");
    return { sessionId: row.sessionId, startedAt: row.authorizedAt, ...(wait ? { waitingForLive: true as const } : {}) };
  }
  async function stop(ownerId: number, sessionId: string) {
    return { stopped: !!await sessions.stop(ownerId, sessionId, "OPERATOR_STOPPED") };
  }

  async function reconcile(row: Session) {
    const id = row.operationId;
    if (!id) return;
    const op = await ledger.get(row.ownerId, id);
    if (!op || op.source !== "auto" || op.campaignId !== row.campaignId || op.fingerprint !== row.baselineFingerprint ||
      op.currentBudgetMinor !== row.baselineBudgetMinor || op.cap.revision !== row.policyRevision) {
      await sessions.markUnknown(row, id);
      return;
    }
    if (op.status === "APPLIED_VERIFIED" && op.observedBudgetMinor === op.targetBudgetMinor && op.observedFingerprint) {
      // Repeat only the idempotent LINE bridge handoff on a lost response, never the TikTok POST.
      await adapters.finishLease(id, "APPLIED_VERIFIED");
      await sessions.settleVerified(row, id, { budgetMinor: op.observedBudgetMinor, fingerprint: op.observedFingerprint });
    } else if (op.status === "NOT_SENT" ||
      (op.status === "PREPARED" && instant(op.expiresAt) <= now().getTime())) {
      await sessions.settleNotSent(row, id);
    } else if (op.status === "OUTCOME_UNKNOWN" || op.status === "APPLIED_VERIFIED" || op.status === "PROVIDER_REJECTED" ||
      (op.status === "PROCESSING" && instant(op.expiresAt) + 30_000 <= now().getTime())) {
      await sessions.markUnknown(row, id);
    }
  }

  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    let reason: PpanAutoTickReason = "ERROR", sessionId: string | null = null, lastValidReadAt: string | null = null;
    let publicDetail: string | undefined;
    try {
      const row = await sessions.getLatest();
      if (!row) { pulse = undefined; reason = "NOT_ARMED"; return; }
      sessionId = row.sessionId;
      const evidence = row.evidenceMode ?? "verified-room", trend = evidence === "spend-trend";
      const roomTrend = evidence === LIVE_ROOM_SPEND_TREND, needsPair = trend || roomTrend;
      const persistent = row.keepAutoAcrossRooms === true;
      if (row.status === "ACTIVE" && !allowedEvidence(evidence)) {
        reason = "AUTO_DISABLED";
        if (!persistent) await sessions.stop(row.ownerId, row.sessionId, "AUTO_DISABLED");
      }
      if (row.operationId) { pulse = undefined; await reconcile(row); reason = row.lastOutcome === "OUTCOME_UNKNOWN" ? "OUTCOME_UNKNOWN" : "PENDING"; return; }
      if (row.status !== "ACTIVE" || !allowedEvidence(evidence)) { pulse = undefined; if (reason !== "AUTO_DISABLED") reason = "SESSION_STOPPED"; return; }
      if (!await recheckOwner(row.ownerId, row.authorizedAt)) { await sessions.stop(row.ownerId, row.sessionId, "AUTHORITY_REVOKED"); reason = "AUTHORITY_REVOKED"; return; }
      if (await legacyBusy()) { if (roomTrend) pulse = undefined; reason = "LEGACY_BUSY"; return; }
      reason = "CONTEXT_UNAVAILABLE";
      const campaign = await discover();
      if (campaign !== row.campaignId) {
        pulse = undefined; reason = "CAMPAIGN_ENDED";
        if (persistent) publicDetail = "CAMPAIGN_NOT_VISIBLE";
        else await sessions.stop(row.ownerId, row.sessionId, "CAMPAIGN_ENDED");
        return;
      }
      // Legacy auto-detect binds only one room. Only the separate persistent
      // opt-in can move to a replacement room for the same campaign.
      const autoDetect = row.autoDetectLive === true;
      if (autoDetect && !canAutoDetect()) { pulse = undefined; return; }
      const tracking = persistent ? await trackPersistent(row, campaign) : null;
      if (tracking && !tracking.full) {
        pulse = undefined; reason = tracking.reason; publicDetail = tracking.detail; return;
      }
      const detectedFull = tracking?.full ?? (autoDetect && !waiting(row)
        ? await read(campaign, evidence, row.liveSessionId ?? undefined, true).catch(() => null) : null);
      if (autoDetect && (waiting(row) || !detectedFull)) {
        pulse = undefined;
        const { context, policy, fenced } = await readDetected(campaign, row.liveSessionId ?? undefined), at = now();
        if (!context) { await sessions.stop(row.ownerId, row.sessionId, "CAMPAIGN_ENDED"); reason = "CAMPAIGN_ENDED"; return; }
        if (!validScheduledContext(context, campaign, at)) return;
        if (policy.revision !== row.policyRevision) { await sessions.stop(row.ownerId, row.sessionId, "CAP_CHANGED"); reason = "CAP_CHANGED"; return; }
        if (context.budgetMinor !== row.baselineBudgetMinor || context.fingerprint !== row.baselineFingerprint) {
          await sessions.stop(row.ownerId, row.sessionId, "BASELINE_CHANGED"); reason = "BASELINE_CHANGED"; return;
        }
        const active = verifiedDetectedRoom(context, at);
        if (row.liveSessionId !== null) {
          if (verifiedEnded(context) || (active && context.liveSessionId !== row.liveSessionId)) {
            await sessions.stop(row.ownerId, row.sessionId, "LIVE_ENDED"); reason = "LIVE_ENDED";
          } else reason = active ? "SPEND_UPDATE_PENDING" : "LIVE_DELIVERY_UNVERIFIED";
          return;
        }
        if (!active) { reason = "LIVE_DELIVERY_UNVERIFIED"; return; }
        const reasons = scheduledBlockers(context, policy, fenced, at, rounding);
        if (reasons.length) { reason = reasons.includes("NATIVE_AUTO_CONFLICT") ? "NATIVE_AUTO_CONFLICT" :
          reasons.includes("WRITE_LOCKED") ? "WRITE_LOCKED" : reasons.includes("LINE_NOT_READY") ? "LINE_NOT_READY" : "CONTEXT_UNAVAILABLE"; return; }
        const bound = await sessions.bindLiveSession(row, context.liveSessionId);
        reason = bound ? "SPEND_UPDATE_PENDING" : "WRITE_LOCKED";
        return; // Binding is not a spend sample or a write.
      }
      if (waiting(row)) {
        pulse = undefined;
        const full = await read(campaign, evidence).catch(() => null);
        if (!full) {
          const { context, policy } = await readScheduled(campaign);
          if (!context) { await sessions.stop(row.ownerId, row.sessionId, "CAMPAIGN_ENDED"); reason = "CAMPAIGN_ENDED"; return; }
          if (!validScheduledContext(context, campaign, now())) return;
          if (policy.revision !== row.policyRevision) { await sessions.stop(row.ownerId, row.sessionId, "CAP_CHANGED"); reason = "CAP_CHANGED"; return; }
          if (context.budgetMinor !== row.baselineBudgetMinor || context.fingerprint !== row.baselineFingerprint) {
            await sessions.stop(row.ownerId, row.sessionId, "BASELINE_CHANGED"); reason = "BASELINE_CHANGED"; return;
          }
          reason = "LIVE_DELIVERY_UNVERIFIED";
          return; // No report, no write and no use of a fabricated zero.
        }
        const { context, policy, fenced } = full, at = now();
        if (context.campaignId !== campaign || !freshContext(context, at)) return;
        if (policy.revision !== row.policyRevision) { await sessions.stop(row.ownerId, row.sessionId, "CAP_CHANGED"); reason = "CAP_CHANGED"; return; }
        if (context.budgetMinor !== row.baselineBudgetMinor || context.fingerprint !== row.baselineFingerprint) {
          await sessions.stop(row.ownerId, row.sessionId, "BASELINE_CHANGED"); reason = "BASELINE_CHANGED"; return;
        }
        const blocked = blockers(context, policy, fenced, at, evidence)[0];
        if (blocked) { reason = blocked; return; }
        // A stale ONGOING report for a room predating this authorization is
        // not evidence of the next LIVE. One minute covers pre-arm/start races.
        const launched = instant(context.liveSessionStartedAt);
        if (!hasRoom(context) || !(launched >= instant(row.authorizedAt) - 60_000 && launched <= at.getTime())) {
          reason = "LIVE_DELIVERY_UNVERIFIED"; return;
        }
        const bound = await sessions.bindLiveSession(row, context.liveSessionId);
        if (bound) observeTrend(bound, context);
        reason = bound ? "SPEND_TREND_PENDING" : "WRITE_LOCKED";
        return; // Never send on the first verified room/spend reading.
      }
      const { context, policy, fenced } = detectedFull ?? await read(campaign, evidence, row.liveSessionId ?? undefined), at = now();
      if (context.campaignId !== campaign || !freshContext(context, at)) { pulse = undefined; return; }
      const verdict = preview(context, policy, at);
      if (verdict.status !== "CONTEXT_UNVERIFIED") lastValidReadAt = context.observedAt;
      reason = "ERROR";
      if (verifiedEnded(context) || (!trend && hasRoom(context) && context.liveSessionId !== row.liveSessionId)) {
        await sessions.stop(row.ownerId, row.sessionId, "LIVE_ENDED"); reason = "LIVE_ENDED"; return;
      }
      if (policy.revision !== row.policyRevision) { await sessions.stop(row.ownerId, row.sessionId, "CAP_CHANGED"); reason = "CAP_CHANGED"; return; }
      if (context.budgetMinor !== row.baselineBudgetMinor || context.fingerprint !== row.baselineFingerprint) {
        pulse = undefined;
        if (!trend) { await sessions.stop(row.ownerId, row.sessionId, "BASELINE_CHANGED"); reason = "BASELINE_CHANGED"; return; }
        if (!canStart(context, policy, fenced, at, evidence, rounding)) { reason = "BASELINE_CHANGED"; return; }
        const adopted = await sessions.adoptBaseline(row, { budgetMinor: context.budgetMinor, fingerprint: context.fingerprint, policyRevision: policy.revision });
        if (adopted) observeTrend(adopted, context);
        reason = adopted ? "BASELINE_ADOPTED" : "WRITE_LOCKED";
        return;
      }
      const current = row;
      if (autoDetect && !verifiedDetectedRoom(context, at)) { pulse = undefined; reason = "LIVE_DELIVERY_UNVERIFIED"; return; }
      const blocked = blockers(context, policy, fenced, at, evidence, current)[0];
      if (blocked) { pulse = undefined; reason = blocked; return; }
      const previousSpend = needsPair ? observeTrend(current, context) : null;
      if (verdict.status !== "WOULD_INCREASE") {
        reason = verdict.status === "BELOW_THRESHOLD" ? "BELOW_THRESHOLD" : verdict.status === "CAMPAIGN_CAP_EXCEEDED" || verdict.status === "CLIENT_DAILY_CAP_EXCEEDED" ? "CAP_REACHED" : "TARGET_UNAVAILABLE";
        return;
      }
      if (needsPair && previousSpend === null) { reason = "SPEND_TREND_PENDING"; return; }
      if (!allowedEvidence(evidence)) { reason = "AUTO_DISABLED"; return; }
      const dayEnd = Date.parse(`${context.reportingDate}T00:00:00+07:00`) + 86_400_000;
      if (roomTrend && dayEnd - now().getTime() < 30_000) {
        pulse = undefined; reason = "SPEND_UPDATE_PENDING"; return;
      }
      const op = await writer.prepare(row.ownerId, { expectedCampaignId: row.campaignId,
        expectedBudgetMinor: row.baselineBudgetMinor, targetBudgetMinor: verdict.targetBudgetMinor }, "auto");
      // Preparing a proposal near midnight can finish after the reporting day
      // changed. Wait for a fresh pair instead of consuming an Auto attempt.
      if (roomTrend && (bangkokDay(now()) !== context.reportingDate || instant(op.expiresAt) - now().getTime() < 15_000)) {
        pulse = undefined; reason = "SPEND_UPDATE_PENDING"; return;
      }
      if (!await sessions.reserve(row, op.operationId, verdict.targetBudgetMinor)) { reason = "WRITE_LOCKED"; return; }
      if (needsPair) pulse = undefined; // A second increase always needs a new pair.
      const allowed = async () => allowedEvidence(evidence) && await recheckOwner(current.ownerId, current.authorizedAt) && await sessions.isReserved(current, op.operationId);
      const result = await writer.confirm(row.ownerId, { operationId: op.operationId,
        ...(trend ? { evidenceMode: "spend-trend" as const } : { ...(roomTrend ? { evidenceMode: LIVE_ROOM_SPEND_TREND } : {}),
          ...(autoDetect ? { autoDetectLive: true as const } : {}), nativeAutoOff: true as const, noConcurrentChanges: true as const }) }, allowed,
        async (latest, latestPolicy) => {
          const nowAt = now(), decision = preview(latest, latestPolicy, nowAt);
          const sameRoom = hasRoom(latest) && latest.liveSessionId === current.liveSessionId;
          const sameSampleScope = previousSpend !== null && latest.reportingDate === context.reportingDate &&
            instant(latest.observedAt) >= instant(context.observedAt) && (!autoDetect || (verifiedDetectedRoom(latest, nowAt) &&
              latest.liveSessionStartedAt === context.liveSessionStartedAt && (latest.roomSpendMinor ?? -1) >= (context.roomSpendMinor ?? Infinity)));
          const qualified = sameSampleScope && (previousSpend.kind === "exhausted"
            ? current.allowExhaustedRecovery === true && autoDetect && confirmedExhaustion(latest, current.lastVerifiedAt !== null) && latest.spendMinor >= context.spendMinor
            : latest.spendMinor > previousSpend.spend && (!autoDetect || (latest.roomSpendMinor ?? -1) > (previousSpend.roomSpend ?? Infinity)));
          const signal = trend ? qualified : sameRoom && (!roomTrend || (qualified && latest.spendMinor >= context.spendMinor));
          const same = latest.campaignId === current.campaignId && latest.budgetMinor === current.baselineBudgetMinor &&
            latest.fingerprint === current.baselineFingerprint && latestPolicy.revision === current.policyRevision &&
            (!persistent || (latest.settingsFingerprint === current.baselineSettingsFingerprint &&
              latest.nonRoiSettingsFingerprint === current.baselineNonRoiSettingsFingerprint));
          const eligible = decision.status === "WOULD_INCREASE" && decision.targetBudgetMinor === verdict.targetBudgetMinor &&
            !blockers(latest, latestPolicy, false, nowAt, evidence, current).length;
          if (trend && (!signal || !same || !eligible)) throw new WebBudgetError(!signal ? "PPAN_TREND_PREFLIGHT_SIGNAL" :
            !same ? "PPAN_TREND_PREFLIGHT_BASELINE" : "PPAN_TREND_PREFLIGHT_POLICY", 409, "ข้อมูลเปลี่ยนระหว่างตรวจซ้ำ");
          if (!signal || !same || !eligible) return false;
          const authorized = await allowed();
          if (trend && !authorized) throw new WebBudgetError("PPAN_TREND_PREFLIGHT_AUTHORITY", 409, "ยืนยันสิทธิ์ปรับงบไม่สำเร็จ");
          return authorized;
        }, rounding);
      await reconcile({ ...row, operationId: op.operationId });
      reason = result.status === "APPLIED_VERIFIED" || result.status === "NOT_SENT" || result.status === "OUTCOME_UNKNOWN" ? result.status : "PENDING";
    } catch (error) { pulse = undefined; throw error; } finally {
      busy = false;
      const display = publicDetail ?? (["AUTO_DISABLED", "CONTEXT_UNAVAILABLE", "NATIVE_AUTO_CONFLICT", "LINE_NOT_READY", "WRITE_LOCKED",
        "LIVE_DELIVERY_UNVERIFIED", "SPEND_UPDATE_PENDING", "SPEND_TREND_PENDING", "BELOW_THRESHOLD", "CAP_REACHED", "TARGET_UNAVAILABLE",
        "LEGACY_BUSY"].includes(reason) ? reason : undefined);
      lastTick = sessionId && display ? { sessionId, at: now().getTime(), reason: display } : undefined;
      if (observeTick) await observeTick({ checkedAt: now().toISOString(), reason, sessionId, lastValidReadAt }).catch(() => undefined);
    }
  }
  return { status, arm, stop, tick };
}
