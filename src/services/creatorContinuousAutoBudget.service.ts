import { randomUUID } from "node:crypto";
import { bangkokDay } from "./creatorRead.service";
import { previewCreatorAutoBudget } from "./creatorAutoBudget.policy";
import type { CreatorContinuousAutoBudgetClient, createCreatorContinuousAutoBudgetStore } from "./creatorContinuousAutoBudget.store";
import type { PpanAutoTickObservation, PpanAutoTickReason } from "./ppanAutoObservability.store";
import { WEB_BUDGET_CAMPAIGN_ID, WEB_BUDGET_MAX_MINOR, WebBudgetError,
  type createCreatorWebBudgetService, type WebBudgetAdapters, type WebBudgetContext, type WebBudgetPolicy, type WebBudgetStore } from "./creatorWebBudget.service";

type Sessions = ReturnType<typeof createCreatorContinuousAutoBudgetStore>;
type Session = NonNullable<Awaited<ReturnType<Sessions["getLatest"]>>>;
type EvidenceMode = "verified-room" | "spend-trend";
type ArmInput = { expectedCampaignId: string; expectedBudgetMinor: number; expectedPolicyRevision: number } & (
  { expectedLiveSessionId: string; nativeAutoOff: true; noConcurrentChanges: true; evidenceMode?: never } |
  { evidenceMode: "spend-trend"; expectedLiveSessionId?: never; nativeAutoOff?: never; noConcurrentChanges?: never });
type Mode = "disabled" | "shadow" | "live";
const unavailable = () => new WebBudgetError("AUTO_BUDGET_NOT_READY", 409, "ข้อมูลสำหรับเปิด Auto ยังไม่ครบ จึงยังไม่ส่งคำสั่งจริง");
const CLIENT = "punpan_020" as const;
function instant(value: unknown) {
  if (typeof value !== "string") return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : NaN;
}
function freshContext(ctx: WebBudgetContext, at: Date) {
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
function blockers(ctx: WebBudgetContext, policy: WebBudgetPolicy, fenced: boolean, at: Date, evidence: EvidenceMode, session?: Session) {
  const codes: PpanAutoTickReason[] = [];
  if (evidence === "spend-trend") {
    if (ctx.nativeAutoState !== "DISABLED" && ctx.nativeAutoState !== "UNKNOWN") codes.push("NATIVE_AUTO_CONFLICT");
    if (verifiedEnded(ctx)) codes.push("LIVE_ENDED");
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

export function createCreatorContinuousAutoBudgetService({ mode, discover, adapters, sessions, writer, ledger, recheckOwner, legacyBusy, observeTick,
  clientId = CLIENT, evidenceMode = () => "verified-room", now = () => new Date() }: {
  mode: () => Mode; discover: () => Promise<string | null>; adapters: WebBudgetAdapters; sessions: Sessions;
  writer: ReturnType<typeof createCreatorWebBudgetService>; ledger: WebBudgetStore;
  recheckOwner: (id: number, authorizedAt: string) => Promise<boolean>; legacyBusy: () => Promise<boolean>;
  observeTick?: (event: PpanAutoTickObservation) => Promise<unknown>;
  clientId?: CreatorContinuousAutoBudgetClient; evidenceMode?: () => EvidenceMode; now?: () => Date;
}) {
  if (clientId !== CLIENT && clientId !== "srihiw") throw new Error("CREATOR_CONTINUOUS_AUTO_SCOPE_UNSUPPORTED");
  const rounding = clientId === CLIENT ? "floor-satang" as const : undefined;
  const preview = (ctx: WebBudgetContext, policy: WebBudgetPolicy, at: Date) => previewCreatorAutoBudget({ now: at, context: ctx, policy, rounding });
  // Deliberately process-local. A restart or incomplete read requires a fresh
  // pair of minute polls; an old qualifying sample never survives a restart.
  let pulse: { key: string; at: number; spend: number } | undefined;
  function observeTrend(row: Session, ctx: WebBudgetContext) {
    const timestamp = instant(ctx.observedAt), anchor = Math.max(instant(row.authorizedAt), row.lastVerifiedAt ? instant(row.lastVerifiedAt) : 0);
    if (!Number.isFinite(anchor) || timestamp <= anchor || !Number.isSafeInteger(ctx.spendMinor) || ctx.spendMinor < 0) {
      pulse = undefined;
      return null;
    }
    const key = `${row.sessionId}:${ctx.reportingDate}:${ctx.fingerprint}:${anchor}`;
    const previous = pulse, gap = previous ? timestamp - previous.at : NaN;
    if (previous?.key === key && gap >= 0 && gap < 40_000 && ctx.spendMinor >= previous.spend) return null;
    pulse = { key, at: timestamp, spend: ctx.spendMinor };
    return previous?.key === key && gap >= 40_000 && gap <= 95_000 && ctx.spendMinor > previous.spend ? previous.spend : null;
  }
  async function read(campaignId: string) {
    const [context, policy, fenced] = await Promise.all([adapters.readContext(campaignId), adapters.readPolicy(), ledger.hasFence()]);
    return { context, policy, fenced };
  }

  async function status(operator: boolean, ownerId?: number) {
    const currentMode = mode();
    const state = operator ? await sessions.getLatest().then(row => ({ row, ok: true })).catch(() => ({ row: null, ok: false })) : { row: null, ok: false };
    const row = state.row, own = row?.ownerId === ownerId ? row : null;
    const evidence = row && row.status !== "STOPPED" ? row.evidenceMode ?? "verified-room" : evidenceMode();
    const ownStatus = own?.status === "ACTIVE" ? (own.operationId ? "SENDING" : "ARMED") : own?.status;
    const continuousSession = own && ownStatus ? { sessionId: own.sessionId, status: ownStatus,
      startedAt: own.authorizedAt, reason: own.stopReason ?? (own.lastOutcome === "OUTCOME_UNKNOWN" ? own.lastOutcome : null) } : null;
    const base = { clientId, strategy: "continuous" as const, mode: currentMode, grant: null, continuousSession,
      ...(evidence === "spend-trend" ? { evidenceMode: evidence } : {}),
      canStop: !!own && own.status !== "STOPPED" };
    if (currentMode === "disabled") return { ...base, canArm: false, preview: null, blockers: [] };
    try {
      const campaign = await discover();
      if (!campaign) return { ...base, canArm: false, preview: null, blockers: ["CAMPAIGN_NOT_VISIBLE"] };
      const { context, policy, fenced } = await read(campaign), at = now();
      const verdict = preview(context, policy, at);
      const canArm = currentMode === "live" && operator && state.ok && (!row || (row.status === "STOPPED" && !row.operationId)) &&
        canStart(context, policy, fenced, at, evidence, rounding) && !await legacyBusy();
      const reasons = blockers(context, policy, fenced, at, evidence, row?.status === "ACTIVE" ? row : undefined);
      if (evidence === "spend-trend" && row?.status === "ACTIVE" && !row.operationId && verdict.status === "WOULD_INCREASE" && !reasons.length) reasons.push("SPEND_TREND_PENDING");
      return { ...base, canArm, preview: { status: verdict.status, campaignId: context.campaignId, currentBudgetMinor: context.budgetMinor,
        liveSessionId: hasRoom(context) ? context.liveSessionId : null,
        spendMinor: context.spendMinor, policyRevision: policy.revision, thresholdMinor: Number((BigInt(context.budgetMinor) * 8n + 9n) / 10n),
        targetBudgetMinor: verdict.status === "WOULD_INCREASE" ? verdict.targetBudgetMinor : null,
        projectedClientSpendMinor: verdict.status === "WOULD_INCREASE" ? verdict.projectedClientSpendMinor : null,
        observedAt: context.observedAt }, blockers: reasons };
    } catch { return { ...base, canArm: false, preview: null, blockers: ["CONTEXT_UNAVAILABLE"] }; }
  }

  async function arm(ownerId: number, input: ArmInput, recheckOperator: () => Promise<boolean>) {
    const evidence = evidenceMode();
    const trend = input.evidenceMode === "spend-trend";
    if (mode() !== "live" || (!trend && clientId !== CLIENT) || !WEB_BUDGET_CAMPAIGN_ID.test(input.expectedCampaignId) || trend !== (evidence === "spend-trend") ||
      (trend ? input.expectedLiveSessionId !== undefined || input.nativeAutoOff !== undefined || input.noConcurrentChanges !== undefined
        : !WEB_BUDGET_CAMPAIGN_ID.test(input.expectedLiveSessionId) || input.nativeAutoOff !== true || input.noConcurrentChanges !== true) || await legacyBusy()) throw unavailable();
    const campaignId = await discover();
    if (!campaignId || campaignId !== input.expectedCampaignId) throw unavailable();
    const { context, policy, fenced } = await read(campaignId);
    if ((!trend && (!hasRoom(context) || context.liveSessionId !== input.expectedLiveSessionId)) || context.campaignId !== campaignId || context.budgetMinor !== input.expectedBudgetMinor ||
      policy.revision !== input.expectedPolicyRevision || !canStart(context, policy, fenced, now(), evidence, rounding) || !await recheckOperator() || mode() !== "live" || evidenceMode() !== evidence) throw unavailable();
    const row = await sessions.arm({ sessionId: randomUUID(), ownerId, campaignId,
      policyRevision: policy.revision, baselineBudgetMinor: context.budgetMinor, baselineFingerprint: context.fingerprint,
      ...(trend ? { evidenceMode: "spend-trend" as const, liveSessionId: null, nativeAutoOffAttested: false as const, noConcurrentChangesAttested: false as const }
        : { liveSessionId: input.expectedLiveSessionId, nativeAutoOffAttested: true as const, noConcurrentChangesAttested: true as const }) });
    if (!row) throw new WebBudgetError("AUTO_BUDGET_SESSION_EXISTS", 409, "มีรอบ Auto หรือรายการที่ยังต้องตรวจสอบอยู่แล้ว");
    return { sessionId: row.sessionId, startedAt: row.authorizedAt };
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
      if (row.status === "ACTIVE" && (mode() !== "live" || evidenceMode() !== evidence)) {
        reason = "AUTO_DISABLED";
        await sessions.stop(row.ownerId, row.sessionId, "AUTO_DISABLED");
      }
      if (row.operationId) { pulse = undefined; await reconcile(row); reason = row.lastOutcome === "OUTCOME_UNKNOWN" ? "OUTCOME_UNKNOWN" : "PENDING"; return; }
      if (row.status !== "ACTIVE" || mode() !== "live" || evidenceMode() !== evidence) { pulse = undefined; if (reason !== "AUTO_DISABLED") reason = "SESSION_STOPPED"; return; }
      if (!await recheckOwner(row.ownerId, row.authorizedAt)) { await sessions.stop(row.ownerId, row.sessionId, "AUTHORITY_REVOKED"); reason = "AUTHORITY_REVOKED"; return; }
      if (await legacyBusy()) { reason = "LEGACY_BUSY"; return; }
      reason = "CONTEXT_UNAVAILABLE";
      const campaign = await discover();
      if (campaign !== row.campaignId) { pulse = undefined; await sessions.stop(row.ownerId, row.sessionId, "CAMPAIGN_ENDED"); reason = "CAMPAIGN_ENDED"; return; }
      const { context, policy, fenced } = await read(campaign), at = now();
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
      const blocked = blockers(context, policy, fenced, at, evidence, current)[0];
      if (blocked) { pulse = undefined; reason = blocked; return; }
      const previousSpend = trend ? observeTrend(current, context) : null;
      if (verdict.status !== "WOULD_INCREASE") {
        reason = verdict.status === "BELOW_THRESHOLD" ? "BELOW_THRESHOLD" : verdict.status === "CAMPAIGN_CAP_EXCEEDED" || verdict.status === "CLIENT_DAILY_CAP_EXCEEDED" ? "CAP_REACHED" : "TARGET_UNAVAILABLE";
        return;
      }
      if (trend && previousSpend === null) { reason = "SPEND_TREND_PENDING"; return; }
      if (mode() !== "live" || evidenceMode() !== evidence) { reason = "AUTO_DISABLED"; return; }
      const op = await writer.prepare(row.ownerId, { expectedCampaignId: row.campaignId,
        expectedBudgetMinor: row.baselineBudgetMinor, targetBudgetMinor: verdict.targetBudgetMinor }, "auto");
      if (!await sessions.reserve(row, op.operationId, verdict.targetBudgetMinor)) { reason = "WRITE_LOCKED"; return; }
      if (trend) pulse = undefined; // Even a proven never-sent attempt needs a new pair.
      const allowed = async () => mode() === "live" && evidenceMode() === evidence && await recheckOwner(current.ownerId, current.authorizedAt) && await sessions.isReserved(current, op.operationId);
      const result = await writer.confirm(row.ownerId, { operationId: op.operationId,
        ...(trend ? { evidenceMode: "spend-trend" as const } : { nativeAutoOff: true as const, noConcurrentChanges: true as const }) }, allowed,
        async (latest, latestPolicy) => {
          const nowAt = now(), decision = preview(latest, latestPolicy, nowAt);
          const signal = trend ? previousSpend !== null && latest.reportingDate === context.reportingDate &&
            instant(latest.observedAt) >= instant(context.observedAt) && latest.spendMinor > previousSpend
            : hasRoom(latest) && latest.liveSessionId === current.liveSessionId;
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
