import { randomUUID } from "node:crypto";
import { bangkokDay } from "./creatorRead.service";
import { allowsScheduledCreatorAuto, isVerifiedRoomCreator, LIVE_ROOM_SPEND_TREND, type CreatorBudgetScope } from "./creatorBudgetScope";

export const WEB_BUDGET_CLIENT_ID = "punpan_020";
export const WEB_BUDGET_OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const WEB_BUDGET_CAMPAIGN_ID = /^[1-9]\d{5,30}$/;
export const WEB_BUDGET_MAX_MINOR = 100_000_000_000;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const CONTEXT_FRESH_MS = 30_000;
const POLICY_FRESH_MS = 20_000;
const PROPOSAL_TTL_MS = 120_000;
const MIN_SEND_WINDOW_MS = 15_000;

export type WebBudgetMode = "disabled" | "dry-run" | "live";
export type WebBudgetSource = "manual" | "auto";
export type WebBudgetOutcome = "NOT_SENT" | "PROVIDER_REJECTED" | "APPLIED_VERIFIED" | "OUTCOME_UNKNOWN";
export type WebBudgetStatus = WebBudgetOutcome | "PREPARED" | "PROCESSING" | "SIMULATED";
export interface WebBudgetPolicy {
  revision: number; campaignCapMinor: number; clientDailyCapMinor: number; readAt: string; locked: boolean;
  capWriteEnabled?: boolean;
  autoLineReady?: boolean;
}
interface WebBudgetCampaignEvidence {
  campaignId: string; reportingDate: string; observedAt: string; budgetMinor: number; fingerprint: string;
  settingsFingerprint?: string;
  nativeAutoState: "DISABLED" | "UNKNOWN" | "ENABLED" | "CONFLICT";
}
export interface WebBudgetPreArmContext extends WebBudgetCampaignEvidence {
  scheduleStartAt: string; scheduleEndAt: string | null;
}
export interface WebBudgetRoomEvidence {
  deliveryVerified?: boolean;
  liveDeliveryState?: "LIVE" | "NOT_LIVE" | "UNKNOWN";
  liveSessionId?: string | null;
  liveSessionStartedAt?: string;
  roomSpendMinor?: number;
  roomEvidenceIssue?: "STALE_ONGOING";
}
export interface WebBudgetContext extends WebBudgetCampaignEvidence, WebBudgetRoomEvidence {
  spendMinor: number; aggregateSpendMinor: number;
  providerSpendObservedAt?: string | null;
  campaignDeliveryStatus?: "ENABLED" | "CAMPAIGN_BUDGET_EXHAUSTED" | "OTHER";
}
export type WebAutoBudgetProof = { previousBudgetMinor: number; targetBudgetMinor: number; rounding?: "floor-satang" };
export type WebBudgetAuthorization = { nativeAutoOff: true; noConcurrentChanges: true; evidenceMode?: typeof LIVE_ROOM_SPEND_TREND; autoDetectLive?: true }
  | { evidenceMode: "spend-trend"; nativeAutoOff?: never; noConcurrentChanges?: never; autoDetectLive?: never };
export type WebBudgetDispatch = WebBudgetAuthorization & {
  campaignId: string; reportingDate: string; expectedBudgetMinor: number; targetBudgetMinor: number;
  campaignCapMinor: number; clientDailyCapMinor: number;
  fingerprint: string; notAfter: string;
  source?: WebBudgetSource;
  canSend: (latest: WebBudgetContext) => Promise<boolean>;
}
export interface WebBudgetAdapters {
  readPolicy(): Promise<WebBudgetPolicy>;
  acquireLease(operationId: string, revision: number, autoBudget?: WebAutoBudgetProof): Promise<WebBudgetPolicy & { operationId: string; expiresAt: string }>;
  finishLease(operationId: string, outcome: WebBudgetOutcome): Promise<void>;
  readContext(expectedCampaignId: string, source?: WebBudgetSource): Promise<WebBudgetContext>;
  readPreArmContext?(expectedCampaignId: string): Promise<WebBudgetPreArmContext | null>;
  readScheduledLiveContext?(expectedCampaignId: string, expectedLiveSessionId?: string, autoDetectLive?: true): Promise<WebBudgetContext>;
  readAutoDetectContext?(expectedCampaignId: string, expectedLiveSessionId?: string): Promise<(WebBudgetPreArmContext & WebBudgetRoomEvidence) | null>;
  dispatch(input: WebBudgetDispatch): Promise<{ outcome: WebBudgetOutcome; observedBudgetMinor?: number; observedFingerprint?: string }>;
}
export interface WebBudgetProposal {
  operationId: string; ownerId: number; mode: Exclude<WebBudgetMode, "disabled">;
  source?: WebBudgetSource;
  campaignId: string; reportingDate: string; currentBudgetMinor: number; targetBudgetMinor: number;
  projectedClientSpendMinor: number; cap: WebBudgetPolicy; fingerprint: string; expiresAt: string;
}
export interface WebBudgetRecord extends WebBudgetProposal {
  status: WebBudgetStatus; observedBudgetMinor: number | null; observedFingerprint?: string;
}
export interface WebBudgetStore {
  create(value: WebBudgetProposal): Promise<void>;
  get(ownerId: number, operationId: string): Promise<WebBudgetRecord | null>;
  hasFence(): Promise<boolean>;
  reserve(ownerId: number, operationId: string, mode: Exclude<WebBudgetMode, "disabled">): Promise<WebBudgetRecord | null>;
  finish(ownerId: number, operationId: string, value: {
    status: Exclude<WebBudgetStatus, "PROCESSING" | "PREPARED">; observedBudgetMinor: number | null; reason: string; observedFingerprint?: string;
  }): Promise<WebBudgetRecord>;
}

export class WebBudgetError extends Error {
  constructor(readonly code: string, readonly httpStatus: number, message: string) { super(message); }
}
function reject(code: string, httpStatus: number, message: string): never { throw new WebBudgetError(code, httpStatus, message); }
const amount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= WEB_BUDGET_MAX_MINOR;
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function timeMs(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : NaN;
}
function isFresh(value: unknown, now: number, maxAge: number): boolean {
  const age = now - timeMs(value);
  return age >= 0 && age <= maxAge;
}
function checkPolicy(raw: WebBudgetPolicy, now: number): WebBudgetPolicy {
  if (!raw || !revision(raw.revision) || !amount(raw.campaignCapMinor) || !amount(raw.clientDailyCapMinor)
    || typeof raw.locked !== "boolean" || !isFresh(raw.readAt, now, POLICY_FRESH_MS)) {
    reject("BUDGET_CAP_UNAVAILABLE", 503, "ยังยืนยันเพดานงบจากระบบเดิมไม่ได้");
  }
  return { revision: raw.revision, campaignCapMinor: raw.campaignCapMinor, clientDailyCapMinor: raw.clientDailyCapMinor,
    readAt: raw.readAt, locked: raw.locked, ...(raw.capWriteEnabled === true ? { capWriteEnabled: true } : {}),
    ...(raw.autoLineReady === true ? { autoLineReady: true } : {}) };
}
function checkContext(raw: WebBudgetContext, expectedCampaignId: string, expectedBudgetMinor: number, now: number) {
  if (!raw || !isFresh(raw.observedAt, now, CONTEXT_FRESH_MS) || raw.reportingDate !== bangkokDay(new Date(now))
    || raw.reportingDate !== bangkokDay(new Date(timeMs(raw.observedAt)))
    || !amount(raw.budgetMinor) || !nonnegative(raw.spendMinor) || !nonnegative(raw.aggregateSpendMinor)
    || raw.aggregateSpendMinor < raw.spendMinor || typeof raw.fingerprint !== "string" || !FINGERPRINT.test(raw.fingerprint)) {
    reject("BUDGET_CONTEXT_UNVERIFIED", 409, "ยังยืนยันงบและยอดใช้ล่าสุดไม่ครบ กรุณารีเฟรชก่อน");
  }
  if (raw.campaignId !== expectedCampaignId || raw.budgetMinor !== expectedBudgetMinor) {
    reject("BUDGET_BASELINE_CHANGED", 409, "แคมเปญหรืองบเปลี่ยนแล้ว กรุณารีเฟรชและตรวจยอดใหม่");
  }
  if (raw.nativeAutoState !== "DISABLED" && raw.nativeAutoState !== "UNKNOWN") {
    reject("BUDGET_NATIVE_AUTO_CONFLICT", 409, "ตรวจพบระบบจัดงบอัตโนมัติอื่นหรือข้อมูลขัดแย้ง");
  }
  return raw;
}
function projectedSpend(policy: WebBudgetPolicy, context: WebBudgetContext, target: number): number {
  if (target === context.budgetMinor) reject("BUDGET_NO_CHANGE", 400, "งบใหม่ต้องต่างจากงบปัจจุบัน");
  if (target <= context.spendMinor) reject("BUDGET_BELOW_SPEND", 409, "งบใหม่ต้องสูงกว่ายอดใช้ที่ TikTok รายงานแล้ว");
  const projected = BigInt(target) + BigInt(context.aggregateSpendMinor - context.spendMinor);
  if (target > policy.campaignCapMinor || projected > BigInt(policy.clientDailyCapMinor)) {
    reject("BUDGET_CAP_EXCEEDED", 409, "งบใหม่หรือยอดรวมรายวันจะเกินเพดานที่ยืนยันไว้");
  }
  return Number(projected);
}
function sameCap(left: WebBudgetPolicy, right: WebBudgetPolicy): boolean {
  return left.revision === right.revision && left.campaignCapMinor === right.campaignCapMinor && left.clientDailyCapMinor === right.clientDailyCapMinor;
}
function result(record: Pick<WebBudgetRecord, "operationId" | "status" | "observedBudgetMinor">) {
  return { operationId: record.operationId, status: record.status, observedBudgetMinor: record.observedBudgetMinor };
}
function proposal(record: WebBudgetProposal) {
  const { operationId, mode, campaignId, currentBudgetMinor, targetBudgetMinor, projectedClientSpendMinor, cap, expiresAt } = record;
  return { operationId, mode, campaignId, currentBudgetMinor, targetBudgetMinor, projectedClientSpendMinor, cap, expiresAt };
}

export function createCreatorWebBudgetService({ store, adapters, mode, clientId = WEB_BUDGET_CLIENT_ID, now = () => new Date() }: {
  store: WebBudgetStore; adapters: WebBudgetAdapters; mode: () => WebBudgetMode; clientId?: CreatorBudgetScope; now?: () => Date;
}) {
  async function getPolicy() { return checkPolicy(await adapters.readPolicy(), now().getTime()); }
  async function validatedInputs(campaignId: string, current: number, target: number, source: WebBudgetSource, roomTrend = false, autoDetectLive?: true) {
    const readContext = roomTrend && adapters.readScheduledLiveContext
      ? adapters.readScheduledLiveContext(campaignId, undefined, autoDetectLive) : adapters.readContext(campaignId, source);
    const [rawCap, rawContext] = await Promise.all([adapters.readPolicy(), readContext.catch(error => {
      if (source === "manual" && !(error instanceof WebBudgetError)) {
        reject("BUDGET_CONTEXT_UNVERIFIED", 409, "ยังยืนยันงบและยอดใช้ล่าสุดไม่ครบ กรุณาลองใหม่");
      }
      throw error;
    })]);
    const timestamp = now().getTime(), cap = checkPolicy(rawCap, timestamp);
    if (cap.locked) reject("BUDGET_POLICY_LOCKED", 409, "ยังมีรายการปรับงบที่ต้องยืนยันผลก่อน");
    const context = checkContext(rawContext, campaignId, current, timestamp);
    return { cap, context, projected: projectedSpend(cap, context, target), timestamp };
  }
  return {
    async status(operator: boolean) {
      const activeMode = operator ? mode() : "disabled";
      const cap = await getPolicy().catch(() => null);
      const fenced = activeMode !== "disabled" && await store.hasFence().catch(() => true);
      return { clientId, mode: activeMode, cap,
        capEditAllowed: operator && cap?.capWriteEnabled === true && !cap.locked && cap.campaignCapMinor === cap.clientDailyCapMinor,
        canPrepare: activeMode !== "disabled" && !!cap && !cap.locked && !fenced };
    },
    async operation(ownerId: number, operationId: string) {
      const row = await store.get(ownerId, operationId);
      if (!row) reject("BUDGET_OPERATION_NOT_FOUND", 404, "ไม่พบรายการนี้");
      if (row.status === "PREPARED" && timeMs(row.expiresAt) <= now().getTime()) return result({ ...row, status: "NOT_SENT" });
      if (row.status === "PROCESSING" && timeMs(row.expiresAt) + CONTEXT_FRESH_MS <= now().getTime()) {
        return result({ ...row, status: row.mode === "live" ? "OUTCOME_UNKNOWN" : "NOT_SENT" });
      }
      return result(row);
    },
    async prepare(ownerId: number, input: { expectedCampaignId: string; expectedBudgetMinor: number; targetBudgetMinor: number }, source: WebBudgetSource = "manual") {
      const activeMode = mode();
      if (activeMode === "disabled") reject("BUDGET_MODE_DISABLED", 403, "ยังไม่ได้เปิดการเตรียมปรับงบจากเว็บ");
      if (source === "auto" && activeMode !== "live") reject("BUDGET_MODE_DISABLED", 403, "ยังไม่เปิด Auto แบบจริง");
      if (!WEB_BUDGET_CAMPAIGN_ID.test(input.expectedCampaignId) || !amount(input.expectedBudgetMinor) || !amount(input.targetBudgetMinor)) {
        reject("BUDGET_INPUT_INVALID", 400, "แคมเปญหรืองบไม่ถูกต้อง");
      }
      if (await store.hasFence()) reject("BUDGET_WRITE_FENCED", 409, "ยังมีรายการปรับงบที่ต้องตรวจผลก่อน");
      const { cap, context, projected, timestamp } = await validatedInputs(input.expectedCampaignId, input.expectedBudgetMinor, input.targetBudgetMinor, source);
      const endOfDay = Date.parse(`${context.reportingDate}T00:00:00+07:00`) + 86_400_000;
      const expiresAt = Math.min(timestamp + PROPOSAL_TTL_MS, endOfDay);
      if (expiresAt - timestamp < MIN_SEND_WINDOW_MS || mode() !== activeMode) reject("BUDGET_MODE_CHANGED", 409, "กรุณาเปิดรายการใหม่อีกครั้ง");
      const row: WebBudgetProposal = { operationId: randomUUID(), ownerId, mode: activeMode, source, campaignId: context.campaignId,
        reportingDate: context.reportingDate, currentBudgetMinor: context.budgetMinor, targetBudgetMinor: input.targetBudgetMinor,
        projectedClientSpendMinor: projected, cap, fingerprint: context.fingerprint, expiresAt: new Date(expiresAt).toISOString() };
      await store.create(row);
      return proposal(row);
    },
    async confirm(ownerId: number, input: { operationId: string } & WebBudgetAuthorization, recheckOperator: () => Promise<boolean>,
      autoGuard?: (context: WebBudgetContext, policy: WebBudgetPolicy) => Promise<boolean>, autoRounding?: "floor-satang") {
      const initial = await store.get(ownerId, input.operationId);
      if (!initial || (initial.source === "auto") !== (typeof autoGuard === "function")) reject("BUDGET_OPERATION_NOT_FOUND", 404, "ไม่พบรายการนี้");
      if (autoRounding !== undefined && (autoRounding !== "floor-satang" || !autoGuard || clientId !== WEB_BUDGET_CLIENT_ID)) {
        reject("BUDGET_INPUT_INVALID", 400, "ไม่รองรับกติกาปัดเศษงบนี้");
      }
      const useTrend = input.evidenceMode === "spend-trend";
      const useRoomTrend = input.evidenceMode === LIVE_ROOM_SPEND_TREND;
      if (input.autoDetectLive !== undefined && (!useRoomTrend || input.autoDetectLive !== true || !adapters.readAutoDetectContext || !adapters.readScheduledLiveContext)) {
        reject("BUDGET_ATTESTATION_REQUIRED", 400, "ต้องยืนยันห้อง LIVE ที่ตรงกับแคมเปญ");
      }
      if (useTrend ? ((clientId !== WEB_BUDGET_CLIENT_ID && clientId !== "srihiw") || initial.source !== "auto" || !autoGuard ||
        (clientId === WEB_BUDGET_CLIENT_ID ? autoRounding !== "floor-satang" : autoRounding !== undefined) ||
        input.nativeAutoOff !== undefined || input.noConcurrentChanges !== undefined)
        : (input.nativeAutoOff !== true || input.noConcurrentChanges !== true || (useRoomTrend ?
          (!allowsScheduledCreatorAuto(clientId) || initial.source !== "auto" || !autoGuard || autoRounding !== undefined) :
          (input.evidenceMode !== undefined || (initial.source === "auto" && isVerifiedRoomCreator(clientId)))))) {
        reject("BUDGET_ATTESTATION_REQUIRED", 400, "ต้องยืนยันสิทธิ์และเงื่อนไขการปรับงบ");
      }
      const nativeReady = (context: WebBudgetContext) => context.nativeAutoState === "DISABLED" || ((useTrend || useRoomTrend) && context.nativeAutoState === "UNKNOWN");
      if (initial.status !== "PREPARED") return result(initial);
      const activeMode = mode();
      if (activeMode === "disabled" || activeMode !== initial.mode) reject("BUDGET_MODE_CHANGED", 409, "โหมดเปลี่ยนแล้ว กรุณาเปิดรายการใหม่");
      if (timeMs(initial.expiresAt) <= now().getTime()) reject("BUDGET_PROPOSAL_EXPIRED", 409, "รายการหมดอายุ กรุณาเปิดรายการใหม่");
      const reserved = await store.reserve(ownerId, input.operationId, activeMode);
      if (!reserved) {
        const row = await store.get(ownerId, input.operationId);
        if (row && row.status !== "PREPARED") return result(row);
        reject("BUDGET_RESERVATION_UNAVAILABLE", 409, "รายการหมดอายุหรือมีรายการอื่นกำลังทำงาน กรุณาตรวจสถานะก่อน");
      }
      let status: Exclude<WebBudgetStatus, "PROCESSING" | "PREPARED"> = "NOT_SENT";
      let reason = "PREFLIGHT_BLOCKED", observedBudgetMinor: number | null = null, observedFingerprint: string | undefined;
      let leaseAttempted = false, dispatchInvoked = false;
      try {
        const source = reserved.source ?? "manual";
        if (source !== (initial.source ?? "manual")) reject("BUDGET_PRECONDITION_CHANGED", 409, "รายการเปลี่ยน กรุณาเปิดรายการใหม่");
        const { cap, context } = await validatedInputs(reserved.campaignId, reserved.currentBudgetMinor, reserved.targetBudgetMinor, source, useRoomTrend, input.autoDetectLive);
        if (!sameCap(reserved.cap, cap) || context.reportingDate !== reserved.reportingDate || context.fingerprint !== reserved.fingerprint) {
          reject("BUDGET_PRECONDITION_CHANGED", 409, "งบหรือเพดานเปลี่ยน กรุณาเปิดรายการใหม่");
        }
        if (autoGuard) {
          if (!nativeReady(context) || cap.autoLineReady !== true) reject(useTrend ? "PPAN_TREND_PREFLIGHT_NATIVE_OR_LINE" : "BUDGET_AUTO_PREFLIGHT", 409, "ข้อมูลสำหรับ Auto ยังไม่พร้อม");
          if (!await autoGuard(context, cap)) reject("BUDGET_AUTO_PREFLIGHT", 409, "ข้อมูลสำหรับ Auto ยังไม่พร้อม");
        }
        if (mode() !== activeMode || !await recheckOperator() || timeMs(reserved.expiresAt) <= now().getTime()) {
          reject("BUDGET_AUTHORITY_CHANGED", 409, "สิทธิ์หรือเวลายืนยันเปลี่ยน กรุณาเปิดรายการใหม่");
        }
        if (activeMode === "dry-run") {
          status = "SIMULATED"; reason = "CHECKED_WITHOUT_PROVIDER_WRITE";
        } else {
          leaseAttempted = true;
          const rawLease = autoGuard ? await adapters.acquireLease(reserved.operationId, reserved.cap.revision,
            { previousBudgetMinor: reserved.currentBudgetMinor, targetBudgetMinor: reserved.targetBudgetMinor,
              ...(autoRounding ? { rounding: autoRounding } : {}) })
            : await adapters.acquireLease(reserved.operationId, reserved.cap.revision);
          const lease = checkPolicy(rawLease, now().getTime());
          const deadline = Math.min(timeMs(rawLease.expiresAt), timeMs(reserved.expiresAt));
          if (rawLease.operationId !== reserved.operationId || !lease.locked || !sameCap(reserved.cap, lease)
            || !Number.isFinite(deadline) || deadline - now().getTime() < MIN_SEND_WINDOW_MS || mode() !== "live" || !await recheckOperator()) {
            reject("BUDGET_LEASE_UNVERIFIED", 409, "ยังยืนยันสิทธิ์ส่งคำสั่งไม่ได้");
          }
          dispatchInvoked = true;
          const sent = await adapters.dispatch({ campaignId: reserved.campaignId, reportingDate: reserved.reportingDate,
            expectedBudgetMinor: reserved.currentBudgetMinor, targetBudgetMinor: reserved.targetBudgetMinor, fingerprint: reserved.fingerprint,
            campaignCapMinor: lease.campaignCapMinor, clientDailyCapMinor: lease.clientDailyCapMinor, source,
            notAfter: new Date(deadline).toISOString(), ...(useTrend ? { evidenceMode: "spend-trend" as const }
              : { ...(useRoomTrend ? { evidenceMode: LIVE_ROOM_SPEND_TREND } : {}), ...(input.autoDetectLive === true ? { autoDetectLive: true as const } : {}), nativeAutoOff: true as const, noConcurrentChanges: true as const }),
            canSend: async latest => mode() === "live" && await recheckOperator() &&
              (!autoGuard || (nativeReady(latest) && await autoGuard(latest, cap))) && mode() === "live" });
          const readbackProof = typeof sent?.observedFingerprint === "string" && FINGERPRINT.test(sent.observedFingerprint) &&
            sent.observedFingerprint !== reserved.fingerprint ? sent.observedFingerprint : undefined;
          if (sent?.outcome === "APPLIED_VERIFIED" && sent.observedBudgetMinor === reserved.targetBudgetMinor && (!(autoRounding || useTrend || useRoomTrend) || readbackProof)) {
            status = "APPLIED_VERIFIED"; reason = "EXACT_PROVIDER_READBACK"; observedBudgetMinor = sent.observedBudgetMinor;
            observedFingerprint = readbackProof;
          } else if (sent?.outcome === "NOT_SENT" || sent?.outcome === "PROVIDER_REJECTED") {
            status = sent.outcome; reason = status;
          } else {
            status = "OUTCOME_UNKNOWN"; reason = "READBACK_UNVERIFIED";
          }
        }
      } catch (error) {
        status = dispatchInvoked ? "OUTCOME_UNKNOWN" : "NOT_SENT";
        reason = dispatchInvoked ? "DISPATCH_RESULT_UNAVAILABLE" : error instanceof WebBudgetError ? error.code : "PREFLIGHT_UNAVAILABLE";
      }
      // Persist the terminal record BEFORE informing the cap owner; never clear an uncertain send fence.
      const terminal = await store.finish(ownerId, reserved.operationId, { status, reason, observedBudgetMinor,
        ...(observedFingerprint ? { observedFingerprint } : {}) });
      if (leaseAttempted && terminal.status === status && status !== "SIMULATED") {
        try { await adapters.finishLease(reserved.operationId, status); } catch { /* The policy lease remains locked on ambiguous delivery. */ }
      }
      return result(terminal);
    },
  };
}
