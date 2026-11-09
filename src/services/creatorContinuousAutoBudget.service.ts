import { randomUUID } from "node:crypto";
import { allowsScheduledCreatorAuto, isContinuousCreatorBudgetScope, LIVE_ROOM_SPEND_TREND, supportsContinuousEvidence, type ContinuousEvidence } from "./creatorBudgetScope";
import { bangkokDay } from "./creatorRead.service";
import { previewCreatorAutoBudget } from "./creatorAutoBudget.policy";
import type { AutoBudgetOverviewState } from "./creatorAutoBudget.service";
import type { CreatorContinuousAutoBudgetClient, createCreatorContinuousAutoBudgetStore } from "./creatorContinuousAutoBudget.store";
import type { PpanAutoTickObservation, PpanAutoTickReason } from "./ppanAutoObservability.store";
import { WEB_BUDGET_CAMPAIGN_ID, WEB_BUDGET_MAX_MINOR, WebBudgetError,
  type createCreatorWebBudgetService, type WebBudgetAdapters, type WebBudgetContext, type WebBudgetPolicy, type WebBudgetPreArmContext, type WebBudgetStore } from "./creatorWebBudget.service";

type Sessions = ReturnType<typeof createCreatorContinuousAutoBudgetStore>;
type Session = NonNullable<Awaited<ReturnType<Sessions["getLatest"]>>>;
type EvidenceMode = ContinuousEvidence;
type ArmInput = { expectedCampaignId: string; expectedBudgetMinor: number; expectedPolicyRevision: number } & (
  { expectedLiveSessionId: string | null; nativeAutoOff: true; noConcurrentChanges: true; evidenceMode?: typeof LIVE_ROOM_SPEND_TREND } |
  { evidenceMode: "spend-trend"; expectedLiveSessionId?: never; nativeAutoOff?: never; noConcurrentChanges?: never });
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
function hasRoom(ctx: WebBudgetContext): ctx is WebBudgetContext & { liveSessionId: string } {
  return ctx.liveDeliveryState === "LIVE" && ctx.deliveryVerified === true && typeof ctx.liveSessionId === "string" && WEB_BUDGET_CAMPAIGN_ID.test(ctx.liveSessionId);
}
function spendReady(ctx: WebBudgetContext, at: Date, after?: string | null) {
  const watermark = instant(ctx.providerSpendObservedAt), age = at.getTime() - watermark;
  return age >= 0 && age <= 5 * 60_000 && watermark <= instant(ctx.observedAt) &&
    bangkokDay(new Date(watermark)) === ctx.reportingDate && (!after || watermark > instant(after));
}
const verifiedEnded = (ctx: WebBudgetContext) => ctx.deliveryVerified === true && ctx.liveDeliveryState === "NOT_LIVE";
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
  const next = BigInt(ctx.budgetMinor) * 6n / 5n;
  return (rounding === "floor-satang" || BigInt(ctx.budgetMinor) * 6n % 5n === 0n) && next > BigInt(ctx.budgetMinor) && next <= BigInt(WEB_BUDGET_MAX_MINOR) && next <= BigInt(policy.campaignCapMinor) &&
    next + BigInt(ctx.aggregateSpendMinor - ctx.spendMinor) <= BigInt(policy.clientDailyCapMinor);
}

const validAmount = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= WEB_BUDGET_MAX_MINOR;
function validScheduledContext(ctx: WebBudgetPreArmContext, campaignId: string, at: Date) {
  const start = instant(ctx.scheduleStartAt), end = ctx.scheduleEndAt === null ? Infinity : instant(ctx.scheduleEndAt);
  return ctx.campaignId === campaignId && freshContext(ctx, at) && validAmount(ctx.budgetMinor) && /^[0-9a-f]{64}$/.test(ctx.fingerprint) &&
    Number.isFinite(start) && end > start && end > at.getTime();
}
function scheduledBlockers(ctx: WebBudgetPreArmContext, policy: WebBudgetPolicy, fenced: boolean, at: Date): string[] {
  const reasons: string[] = [];
  const age = at.getTime() - instant(policy.readAt);
  if (!validAmount(policy.campaignCapMinor) || !validAmount(policy.clientDailyCapMinor) || !Number.isSafeInteger(policy.revision) ||
    policy.revision < 1 || !(age >= 0 && age <= 20_000)) reasons.push("CONTEXT_UNAVAILABLE");
  else if (BigInt(ctx.budgetMinor) * 6n > BigInt(Math.min(policy.campaignCapMinor, policy.clientDailyCapMinor)) * 5n) reasons.push("SCHEDULED_CAP_TOO_LOW");
  if (ctx.budgetMinor % 5 !== 0) reasons.push("SCHEDULED_TARGET_NOT_EXACT");
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
  const roundingFor = (evidence: EvidenceMode) => clientId === CLIENT && evidence !== LIVE_ROOM_SPEND_TREND ? "floor-satang" as const : undefined;
  const canWaitForLive = () => allowsScheduledCreatorAuto(clientId) && !!adapters.readPreArmContext &&
    (scheduledLive ? scheduledLive() : evidenceMode() === LIVE_ROOM_SPEND_TREND && mode() === "live");
  const allowedEvidence = (evidence: EvidenceMode) => (mode() === "live" && evidenceMode() === evidence) ||
    (evidence === LIVE_ROOM_SPEND_TREND && canWaitForLive());
  const waiting = (row: Session | null | undefined) => row?.status === "ACTIVE" && !row.operationId && row.liveSessionId === null && row.evidenceMode === LIVE_ROOM_SPEND_TREND;
  const preview = (ctx: WebBudgetContext, policy: WebBudgetPolicy, at: Date, evidence: EvidenceMode) =>
    previewCreatorAutoBudget({ now: at, context: ctx, policy, rounding: roundingFor(evidence) });
  // Deliberately process-local. A restart or incomplete read requires a fresh
  // pair of minute polls; an old qualifying sample never survives a restart.
  let pulse: { key: string; at: number; spend: number } | undefined;
  function observeTrend(row: Session, ctx: WebBudgetContext) {
    const timestamp = instant(ctx.observedAt), anchor = Math.max(instant(row.authorizedAt), row.lastVerifiedAt ? instant(row.lastVerifiedAt) : 0);
    if (!Number.isFinite(anchor) || timestamp <= anchor || !Number.isSafeInteger(ctx.spendMinor) || ctx.spendMinor < 0) {
      pulse = undefined;
      return null;
    }
    const key = `${row.sessionId}:${ctx.reportingDate}:${ctx.fingerprint}:${anchor}:${row.evidenceMode === LIVE_ROOM_SPEND_TREND ? ctx.liveSessionId : ""}`;
    const previous = pulse, gap = previous ? timestamp - previous.at : NaN;
    if (previous?.key === key && gap >= 0 && gap < 40_000 && ctx.spendMinor >= previous.spend) return null;
    pulse = { key, at: timestamp, spend: ctx.spendMinor };
    return previous?.key === key && gap >= 40_000 && gap <= 95_000 && ctx.spendMinor > previous.spend ? previous.spend : null;
  }
  async function read(campaignId: string, evidence: EvidenceMode, expectedLiveSessionId?: string) {
    const readContext = evidence === LIVE_ROOM_SPEND_TREND && adapters.readScheduledLiveContext
      ? adapters.readScheduledLiveContext(campaignId, expectedLiveSessionId) : adapters.readContext(campaignId);
    const [context, policy, fenced] = await Promise.all([readContext, adapters.readPolicy(), ledger.hasFence()]);
    return { context, policy, fenced };
  }
  async function readScheduled(campaignId: string) {
    const [context, policy, fenced] = await Promise.all([adapters.readPreArmContext!(campaignId), adapters.readPolicy(), ledger.hasFence()]);
    return { context, policy, fenced };
  }

  async function status(operator: boolean, ownerId?: number, view?: "summary") {
    const currentMode = canWaitForLive() ? "live" : mode();
    const readOwnerState = operator && (view !== "summary" || (typeof ownerId === "number" && Number.isSafeInteger(ownerId) && ownerId > 0));
    const state = readOwnerState ? await sessions.getLatest().then(row => ({ row, ok: true })).catch(() => ({ row: null, ok: false })) : { row: null, ok: false };
    const row = state.row, own = row?.ownerId === ownerId ? row : null;
    const visible = view === "summary" ? own : row;
    const evidence = visible && visible.status !== "STOPPED" ? visible.evidenceMode ?? "verified-room" : evidenceMode();
    const ownStatus = own?.status === "ACTIVE" ? (own.operationId ? "SENDING" : "ARMED") : own?.status;
    const continuousSession = own && ownStatus ? { sessionId: own.sessionId, status: ownStatus,
      startedAt: own.authorizedAt, reason: own.stopReason ?? (own.lastOutcome === "OUTCOME_UNKNOWN" ? own.lastOutcome : null),
      ...(waiting(own) ? { waitingForLive: true as const } : {}) } : null;
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
      if (!campaign) return { ...base, canArm: false, preview: null, blockers: ["CAMPAIGN_NOT_VISIBLE"] };
      const canRequest = currentMode === "live" && operator && state.ok && (!row || (row.status === "STOPPED" && !row.operationId));
      const canReadScheduled = canWaitForLive() && (canRequest || waiting(own));
      // When offering the new authorization, do not equate historical spend with
      // a current room. Existing spend-trend rounds keep their original reads.
      const full = await read(campaign, canReadScheduled ? LIVE_ROOM_SPEND_TREND : evidence,
        row?.status === "ACTIVE" ? row.liveSessionId ?? undefined : undefined)
        .catch(error => { if (!canReadScheduled) throw error; return null; });
      if (canReadScheduled && (!full || !hasRoom(full.context) || waiting(own))) {
        const { context, policy, fenced } = await readScheduled(campaign), at = now();
        if (!context || !validScheduledContext(context, campaign, at)) return { ...base, canArm: false, preview: null, blockers: ["CONTEXT_UNAVAILABLE"] };
        const reasons = scheduledBlockers(context, policy, fenced, at);
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
      const verdict = preview(context, policy, at, selected);
      const canArm = canRequest && allowedEvidence(selected) &&
        canStart(context, policy, fenced, at, selected, roundingFor(selected)) && !await legacyBusy();
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
    const wait = input.expectedLiveSessionId === null && evidence === LIVE_ROOM_SPEND_TREND && canWaitForLive();
    if (!allowedEvidence(evidence) || !supportsContinuousEvidence(clientId, evidence) || !WEB_BUDGET_CAMPAIGN_ID.test(input.expectedCampaignId) ||
      input.evidenceMode !== (evidence === "verified-room" ? undefined : evidence) ||
      (trend ? input.expectedLiveSessionId !== undefined || input.nativeAutoOff !== undefined || input.noConcurrentChanges !== undefined
        : (!wait && (typeof input.expectedLiveSessionId !== "string" || !WEB_BUDGET_CAMPAIGN_ID.test(input.expectedLiveSessionId))) ||
          input.nativeAutoOff !== true || input.noConcurrentChanges !== true) || await legacyBusy()) throw unavailable();
    const campaignId = await discover();
    if (!campaignId || campaignId !== input.expectedCampaignId) throw unavailable();
    const ready = wait ? await readScheduled(campaignId).then(({ context, policy, fenced }) => {
      const at = now();
      return context && validScheduledContext(context, campaignId, at) && !scheduledBlockers(context, policy, fenced, at).length ? { context, policy } : null;
    }) : await read(campaignId, evidence).then(({ context, policy, fenced }) =>
      (trend || hasRoom(context) && context.liveSessionId === input.expectedLiveSessionId) && canStart(context, policy, fenced, now(), evidence, roundingFor(evidence))
        ? { context, policy } : null);
    if (!ready || ready.context.campaignId !== campaignId || ready.context.budgetMinor !== input.expectedBudgetMinor ||
      ready.policy.revision !== input.expectedPolicyRevision || !await recheckOperator() || !allowedEvidence(evidence)) throw unavailable();
    const { context, policy } = ready;
    const row = await sessions.arm({ sessionId: randomUUID(), ownerId, campaignId,
      policyRevision: policy.revision, baselineBudgetMinor: context.budgetMinor, baselineFingerprint: context.fingerprint,
      ...(trend ? { evidenceMode: "spend-trend" as const, liveSessionId: null, nativeAutoOffAttested: false as const, noConcurrentChangesAttested: false as const }
        : { ...(evidence === LIVE_ROOM_SPEND_TREND ? { evidenceMode: evidence } : {}), liveSessionId: input.expectedLiveSessionId,
          nativeAutoOffAttested: true as const, noConcurrentChangesAttested: true as const }) });
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
    try {
      const row = await sessions.getLatest();
      if (!row) { pulse = undefined; reason = "NOT_ARMED"; return; }
      sessionId = row.sessionId;
      const evidence = row.evidenceMode ?? "verified-room", trend = evidence === "spend-trend";
      const roomTrend = evidence === LIVE_ROOM_SPEND_TREND, needsPair = trend || roomTrend;
      const rounding = roundingFor(evidence);
      if (row.status === "ACTIVE" && !allowedEvidence(evidence)) {
        reason = "AUTO_DISABLED";
        await sessions.stop(row.ownerId, row.sessionId, "AUTO_DISABLED");
      }
      if (row.operationId) { pulse = undefined; await reconcile(row); reason = row.lastOutcome === "OUTCOME_UNKNOWN" ? "OUTCOME_UNKNOWN" : "PENDING"; return; }
      if (row.status !== "ACTIVE" || !allowedEvidence(evidence)) { pulse = undefined; if (reason !== "AUTO_DISABLED") reason = "SESSION_STOPPED"; return; }
      if (!await recheckOwner(row.ownerId, row.authorizedAt)) { await sessions.stop(row.ownerId, row.sessionId, "AUTHORITY_REVOKED"); reason = "AUTHORITY_REVOKED"; return; }
      if (await legacyBusy()) { if (roomTrend) pulse = undefined; reason = "LEGACY_BUSY"; return; }
      reason = "CONTEXT_UNAVAILABLE";
      const campaign = await discover();
      if (campaign !== row.campaignId) { pulse = undefined; await sessions.stop(row.ownerId, row.sessionId, "CAMPAIGN_ENDED"); reason = "CAMPAIGN_ENDED"; return; }
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
      const { context, policy, fenced } = await read(campaign, evidence, row.liveSessionId ?? undefined), at = now();
      if (context.campaignId !== campaign || !freshContext(context, at)) { pulse = undefined; return; }
      const verdict = preview(context, policy, at, evidence);
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
          nativeAutoOff: true as const, noConcurrentChanges: true as const }) }, allowed,
        async (latest, latestPolicy) => {
          const nowAt = now(), decision = preview(latest, latestPolicy, nowAt, evidence);
          const sameRoom = hasRoom(latest) && latest.liveSessionId === current.liveSessionId;
          const rising = previousSpend !== null && latest.reportingDate === context.reportingDate &&
            instant(latest.observedAt) >= instant(context.observedAt) && latest.spendMinor > previousSpend;
          const signal = trend ? rising : sameRoom && (!roomTrend || (rising && latest.spendMinor >= context.spendMinor));
          const same = latest.campaignId === current.campaignId && latest.budgetMinor === current.baselineBudgetMinor &&
            latest.fingerprint === current.baselineFingerprint && latestPolicy.revision === current.policyRevision;
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
      if (observeTick) await observeTick({ checkedAt: now().toISOString(), reason, sessionId, lastValidReadAt }).catch(() => undefined);
    }
  }
  return { status, arm, stop, tick };
}
