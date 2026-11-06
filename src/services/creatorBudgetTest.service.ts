import crypto from "node:crypto";
import { z } from "zod";
import { bangkokDay, CREATOR_BINDING, minor } from "./creatorRead.service";

/** A single, explicitly dated test. This is NOT a general advertising writer. */
export const CREATOR_BUDGET_TEST_CAMPAIGN = "1881130110195874";
export const CREATOR_BUDGET_TEST_BASELINE_MODIFY_TIME = "2026-11-06 18:06:28";
export const CREATOR_BUDGET_TEST_BASELINE_ROI = 30;
const INFO_URL = "https://business-api.tiktok.com/open_api/v1.3/campaign/gmv_max/info/";
const UPDATE_URL = "https://business-api.tiktok.com/open_api/v1.3/campaign/gmv_max/update/";
type Row = Record<string, any>;
const bindingSchema = z.object({
  advertiserId: z.literal(CREATOR_BINDING.advertiserId),
  tiktokAccountId: z.literal(CREATOR_BINDING.tiktokAccountId),
  identityId: z.literal(CREATOR_BINDING.identityId),
  identityType: z.literal(CREATOR_BINDING.identityType),
  identityAuthorizedBcId: z.literal(CREATOR_BINDING.identityAuthorizedBcId),
}).strict();
const id = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
const iso = z.string().datetime({ offset: true });
export const creatorBudgetTestPermitSchema = z.object({
  permitId: id, clientId: z.literal("punpan_020"), binding: bindingSchema,
  campaignId: z.literal(CREATOR_BUDGET_TEST_CAMPAIGN),
  expectedBudgetMinor: z.literal(300000), targetBudgetMinor: z.literal(360000), capMinor: z.literal(1000000),
  policyRevision: z.number().int().positive().safe(), localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notBefore: iso, expiresAt: iso,
  nativeAutoBudgetVerifiedOff: z.boolean(), exclusiveWriterConfirmed: z.boolean(),
}).strict().superRefine((value, context) => {
  const start = new Date(value.notBefore), end = new Date(value.expiresAt);
  if (end.getTime() <= start.getTime() || end.getTime() - start.getTime() > 86_400_000
    || bangkokDay(start) !== value.localDate || bangkokDay(new Date(end.getTime() - 1)) !== value.localDate) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_APPROVAL_WINDOW" });
  }
});
export type CreatorBudgetTestPermit = z.infer<typeof creatorBudgetTestPermitSchema>;
export const creatorBudgetTestRequestSchema = z.object({
  permitId: id, policyRevision: z.number().int().positive().safe(),
  campaignId: z.literal(CREATOR_BUDGET_TEST_CAMPAIGN), expectedBudgetMinor: z.literal(300000),
  targetBudgetMinor: z.literal(360000), capMinor: z.literal(1000000),
}).strict();
export type CreatorBudgetTestStatus = "SEND_RESERVED" | "SUCCEEDED" | "FAILED_REJECTED" | "FAILED_NOT_SENT"
  | "OUTCOME_UNKNOWN" | "RECONCILED_TARGET_OBSERVED" | "CONFLICT_OBSERVED";
export interface CreatorBudgetTestOperation {
  permitId: string;
  fingerprint: string;
  permit: CreatorBudgetTestPermit;
  status: CreatorBudgetTestStatus;
  postCount: 1;
  providerAccepted: boolean | null;
  observedBudgetMinor: number | null;
  reason: string;
  createdAt: string;
  updatedAt: string;
}
export interface CreatorBudgetTestStore {
  ensureSchema(): Promise<void>;
  get(permitId: string): Promise<CreatorBudgetTestOperation | null>;
  reserve(permit: CreatorBudgetTestPermit, fingerprint: string, baseline: Row): Promise<{ created: boolean; operation: CreatorBudgetTestOperation }>;
  finish(permitId: string, fingerprint: string, result: Pick<CreatorBudgetTestOperation, "status" | "providerAccepted" | "observedBudgetMinor" | "reason">): Promise<CreatorBudgetTestOperation>;
}
export class CreatorBudgetTestError extends Error {
  constructor(readonly code: string, readonly httpStatus = 503, readonly provenNoSend = false) { super(code); }
}
export interface CreatorBudgetTestDependencies {
  enabled: () => boolean;
  /** Untrusted env JSON or parsed value. Missing/invalid configuration never arms. */
  permit: () => unknown;
  store: CreatorBudgetTestStore;
  /** Must be a NEW uncached Creator reader invocation, not the LINE snapshot cache. */
  freshSnapshot: () => Promise<Row>;
  loadToken: () => Promise<string>;
  /** Raw data of the fixed campaign info GET. Optional override is for adapters/tests. */
  freshCampaignInfo?: () => Promise<Row>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}
function parsePermit(raw: unknown): CreatorBudgetTestPermit | null {
  try {
    const parsed = creatorBudgetTestPermitSchema.safeParse(typeof raw === "string" ? JSON.parse(raw) : raw);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
export function creatorBudgetTestFingerprint(permit: CreatorBudgetTestPermit): string {
  // zod's object parser supplies a deterministic field order, including the binding.
  return crypto.createHash("sha256").update(JSON.stringify(creatorBudgetTestPermitSchema.parse(permit))).digest("hex");
}
function exactBinding(value: unknown): boolean { return bindingSchema.safeParse(value).success; }
function safeMoney(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function noShop(value: unknown): boolean { return value == null || value === "" || value === "0"; }
function gate(permit: CreatorBudgetTestPermit, now: Date): string | null {
  if (!permit.nativeAutoBudgetVerifiedOff) return "NATIVE_AUTO_BUDGET_OFF_NOT_VERIFIED";
  if (!permit.exclusiveWriterConfirmed) return "EXCLUSIVE_WRITER_NOT_CONFIRMED";
  if (bangkokDay(now) !== permit.localDate) return "NOT_APPROVED_LOCAL_DATE";
  if (now.getTime() < Date.parse(permit.notBefore)) return "BEFORE_APPROVED_WINDOW";
  if (now.getTime() >= Date.parse(permit.expiresAt)) return "APPROVAL_WINDOW_EXPIRED";
  return null;
}
function result(operation: CreatorBudgetTestOperation) {
  const safe = ["SUCCEEDED", "FAILED_REJECTED", "FAILED_NOT_SENT"].includes(operation.status);
  return { ok: operation.status === "SUCCEEDED", permitId: operation.permitId, status: operation.status,
    postCount: operation.postCount, writeAttempted: operation.status !== "FAILED_NOT_SENT",
    providerAccepted: operation.providerAccepted, observedBudgetMinor: operation.observedBudgetMinor,
    reason: operation.reason, lockSafeToRelease: safe, updatedAt: operation.updatedAt };
}
function wait(permitId: string, reason: string) {
  return { ok: false, permitId, status: "WAIT" as const, postCount: 0, writeAttempted: false,
    providerAccepted: null, observedBudgetMinor: null, reason, lockSafeToRelease: true };
}
/** Bounded JSON parsing; response messages, URLs and tokens are never reflected. */
async function boundedJson(response: Response): Promise<Row> {
  if (Number(response.headers.get("content-length")) > 65_536 || !response.body) throw new Error("RESPONSE_BOUNDARY");
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 65_536) { await reader.cancel(); throw new Error("RESPONSE_BOUNDARY"); }
      chunks.push(Buffer.from(chunk.value));
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("RESPONSE_UNVERIFIED");
    return parsed;
  } finally { reader.releaseLock(); }
}
function utcTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(" ", "T") + "Z" : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) return null;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
function infoBaseline(info: Row, permit: CreatorBudgetTestPermit, now: Date, budgetMinor: number, requireOriginalBaseline = false): Row {
  const identity = info?.identity_list?.[0];
  if (info?.advertiser_id !== CREATOR_BINDING.advertiserId || info?.campaign_id !== permit.campaignId
    || info?.shopping_ads_type !== "LIVE" || info?.operation_status !== "ENABLE"
    || !noShop(info.store_id) || !noShop(info.store_authorized_bc_id)
    || !Array.isArray(info.identity_list) || info.identity_list.length !== 1
    || identity?.identity_id !== CREATOR_BINDING.identityId || identity?.identity_type !== CREATOR_BINDING.identityType
    || identity?.identity_authorized_bc_id !== CREATOR_BINDING.identityAuthorizedBcId
    || !noShop(identity?.store_id) || !noShop(identity?.identity_authorized_shop_id)
    || (info.tiktok_account_id !== undefined && info.tiktok_account_id !== CREATOR_BINDING.tiktokAccountId)) {
    throw new CreatorBudgetTestError("CREATOR_IDENTITY_BINDING_UNVERIFIED", 409, true);
  }
  let budget: number;
  try { budget = minor(info.budget); } catch { throw new CreatorBudgetTestError("BASELINE_BUDGET_UNVERIFIED", 409, true); }
  if (budget !== budgetMinor) throw new CreatorBudgetTestError("BASELINE_BUDGET_CHANGED", 409, true);
  if (typeof info.roas_bid !== "number" || !Number.isFinite(info.roas_bid) || info.roas_bid <= 0
    || typeof info.modify_time !== "string" || !info.modify_time.length || info.modify_time.length > 80) {
    throw new CreatorBudgetTestError("BASELINE_METADATA_UNVERIFIED", 409, true);
  }
  if (requireOriginalBaseline && (info.roas_bid !== CREATOR_BUDGET_TEST_BASELINE_ROI
    || info.modify_time !== CREATOR_BUDGET_TEST_BASELINE_MODIFY_TIME)) {
    throw new CreatorBudgetTestError("APPROVED_BASELINE_CHANGED", 409, true);
  }
  // A missing native-auto field is UNKNOWN, never silently interpreted as OFF.
  if (info.auto_budget?.auto_budget_enabled === true || info.auto_budget_enabled === true) {
    throw new CreatorBudgetTestError("NATIVE_AUTO_BUDGET_ENABLED", 409, true);
  }
  const fromNow = ["FROM_NOW", "SCHEDULE_FROM_NOW"].includes(info.schedule_type);
  const startEnd = ["START_END", "SCHEDULE_START_END"].includes(info.schedule_type);
  const start = utcTime(info.schedule_start_time), end = utcTime(info.schedule_end_time);
  if ((!fromNow && !startEnd) || start === null || start > now.getTime()
    || (startEnd && (end === null || end <= now.getTime() || end <= start))) {
    throw new CreatorBudgetTestError("CAMPAIGN_SCHEDULE_NOT_ELIGIBLE", 409, true);
  }
  return { budgetMinor: budget, targetRoi: info.roas_bid, modifyTime: info.modify_time,
    scheduleType: info.schedule_type, scheduleStart: info.schedule_start_time, scheduleEnd: info.schedule_end_time ?? null };
}
function snapshotCheck(snapshot: Row, permit: CreatorBudgetTestPermit, now: Date): void {
  const campaign = snapshot?.campaign, quality = snapshot?.quality;
  const observed = Date.parse(snapshot?.observedAt);
  if (snapshot?.clientId !== "punpan_020" || snapshot.source !== "tiktok-creator-api" || snapshot.readOnly !== true
    || !exactBinding(snapshot.binding) || snapshot.timezone !== "Asia/Bangkok" || snapshot.reportingDate !== permit.localDate
    || !Number.isFinite(observed) || now.getTime() - observed > 30_000 || observed - now.getTime() > 5_000
    || bangkokDay(now) !== permit.localDate) throw new CreatorBudgetTestError("FRESH_SNAPSHOT_UNVERIFIED", 409, true);
  if (!campaign || campaign.campaignId !== permit.campaignId || campaign.status !== "ACTIVE" || campaign.operationStatus !== "ENABLE"
    || campaign.currency !== "THB" || campaign.dailyBudgetMinor !== permit.expectedBudgetMinor
    || typeof campaign.targetRoi !== "number" || !Number.isFinite(campaign.targetRoi) || campaign.targetRoi <= 0) {
    throw new CreatorBudgetTestError("BASELINE_CAMPAIGN_CHANGED", 409, true);
  }
  if (snapshot.nativeAutoBudgetState === "ENABLED") throw new CreatorBudgetTestError("NATIVE_AUTO_BUDGET_ENABLED", 409, true);
  if (!["ENABLED", "DISABLED", "UNKNOWN"].includes(snapshot.nativeAutoBudgetState)) {
    throw new CreatorBudgetTestError("NATIVE_AUTO_BUDGET_STATE_UNVERIFIED", 409, true);
  }
  if (!safeMoney(campaign.spendMinor) || quality?.aggregateSpendComplete !== true || !safeMoney(quality.aggregateSpendMinor)
    || quality.aggregateSpendMinor < campaign.spendMinor) throw new CreatorBudgetTestError("COMPLETE_SPEND_UNAVAILABLE", 409, true);
  if (BigInt(permit.expectedBudgetMinor) * 12n !== BigInt(permit.targetBudgetMinor) * 10n
    || permit.targetBudgetMinor > permit.capMinor
    || quality.aggregateSpendMinor + Math.max(0, permit.targetBudgetMinor - campaign.spendMinor) > permit.capMinor) {
    throw new CreatorBudgetTestError("DAILY_CAP_WOULD_BE_EXCEEDED", 409, true);
  }
}

export function createCreatorBudgetTestService(deps: CreatorBudgetTestDependencies) {
  const now = deps.now ?? (() => new Date()), fetchImpl = deps.fetchImpl ?? fetch;
  function configured() { return parsePermit(deps.permit()); }
  async function token() {
    const value = await deps.loadToken();
    if (typeof value !== "string" || value.length < 16) throw new CreatorBudgetTestError("WRITER_CREDENTIAL_UNAVAILABLE");
    return value;
  }
  const freshInfo = deps.freshCampaignInfo ?? (async () => {
    const accessToken = await token(), url = new URL(INFO_URL);
    url.searchParams.set("advertiser_id", CREATOR_BINDING.advertiserId);
    url.searchParams.set("campaign_id", CREATOR_BUDGET_TEST_CAMPAIGN);
    try {
      const response = await fetchImpl(url, { method: "GET", redirect: "error", headers: { "Access-Token": accessToken, Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
      const payload = await boundedJson(response);
      if (!response.ok || payload.code !== 0 || !payload.data || typeof payload.data !== "object") throw new Error("INFO_UNAVAILABLE");
      return payload.data;
    } catch { throw new CreatorBudgetTestError("FRESH_CAMPAIGN_INFO_UNAVAILABLE", 502, true); }
  });
  async function persist(operation: CreatorBudgetTestOperation, update: Parameters<CreatorBudgetTestStore["finish"]>[2]) {
    try { return result(await deps.store.finish(operation.permitId, operation.fingerprint, update)); }
    catch {
      return result({ ...operation, ...update, status: "OUTCOME_UNKNOWN", reason: "LEDGER_RESULT_UNAVAILABLE", updatedAt: now().toISOString() });
    }
  }
  async function getOperation(permitId: string) {
    if (!id.safeParse(permitId).success) throw new CreatorBudgetTestError("PERMIT_ID_INVALID", 400, true);
    const operation = await deps.store.get(permitId);
    if (!operation) throw new CreatorBudgetTestError("NOT_FOUND", 404);
    const permit = parsePermit(operation.permit);
    if (!permit || operation.fingerprint !== creatorBudgetTestFingerprint(permit)) throw new CreatorBudgetTestError("LEDGER_SCOPE_UNVERIFIED");
    return operation;
  }
  return {
    metadata() {
      const permit = configured();
      return { enabled: deps.enabled(), configured: !!permit, canWriteNow: false, oneShot: true,
        configurationReason: !permit ? "EXPLICIT_PERMIT_REQUIRED" : gate(permit, now()) ?? "FRESH_PREFLIGHT_REQUIRED",
        permit: permit ? { permitId: permit.permitId, policyRevision: permit.policyRevision, localDate: permit.localDate, notBefore: permit.notBefore, expiresAt: permit.expiresAt } : null,
        capabilities: { budgetOnly: true, create: false, roi: false, pause: false, resume: false, automaticRetry: false } };
    },
    async initialize() {
      const permit = configured();
      if (!deps.enabled() || !permit || !permit.nativeAutoBudgetVerifiedOff || !permit.exclusiveWriterConfirmed
        || now().getTime() >= Date.parse(permit.expiresAt)) return false;
      await deps.store.ensureSchema();
      return true;
    },
    async execute(input: unknown) {
      if (!deps.enabled()) throw new CreatorBudgetTestError("BUDGET_TEST_DISABLED", 503, true);
      const permit = configured();
      if (!permit) throw new CreatorBudgetTestError("EXPLICIT_PERMIT_REQUIRED", 503, true);
      const parsed = creatorBudgetTestRequestSchema.safeParse(input);
      if (!parsed.success) throw new CreatorBudgetTestError("FIXED_TEST_SCOPE_REQUIRED", 400, true);
      for (const field of Object.keys(parsed.data) as Array<keyof typeof parsed.data>) {
        if (parsed.data[field] !== permit[field]) throw new CreatorBudgetTestError("PERMIT_REQUEST_MISMATCH", 409, true);
      }
      const fingerprint = creatorBudgetTestFingerprint(permit);
      const existing = await deps.store.get(permit.permitId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CreatorBudgetTestError("PERMIT_REUSE_CONFLICT", 409);
        return result(existing); // No new preflight or POST, even after a process restart.
      }
      const initialGate = gate(permit, now());
      if (initialGate) return wait(permit.permitId, initialGate);
      let snapshot: Row, baseline: Row, repeated: Row;
      try {
        snapshot = await deps.freshSnapshot();
        snapshotCheck(snapshot, permit, now());
        if (BigInt(snapshot.campaign.spendMinor) * 10000n < BigInt(permit.expectedBudgetMinor) * 8000n) return wait(permit.permitId, "SPEND_THRESHOLD_NOT_REACHED");
        baseline = infoBaseline(await freshInfo(), permit, now(), permit.expectedBudgetMinor, true);
        if (baseline.targetRoi !== snapshot.campaign.targetRoi) throw new CreatorBudgetTestError("ROI_BASELINE_CHANGED", 409, true);
        repeated = infoBaseline(await freshInfo(), permit, now(), permit.expectedBudgetMinor, true);
      } catch (error) {
        if (error instanceof CreatorBudgetTestError) throw error;
        return wait(permit.permitId, "FRESH_DATA_UNAVAILABLE");
      }
      if (JSON.stringify(baseline) !== JSON.stringify(repeated)) throw new CreatorBudgetTestError("MANUAL_CHANGE_DETECTED", 409, true);
      snapshotCheck(snapshot, permit, now());
      let accessToken: string;
      try { accessToken = await token(); } catch { return wait(permit.permitId, "WRITER_CREDENTIAL_UNAVAILABLE"); }
      const latest = configured(), finalGate = gate(permit, now());
      if (!deps.enabled() || !latest || creatorBudgetTestFingerprint(latest) !== fingerprint) return wait(permit.permitId, "APPROVAL_CHANGED");
      if (finalGate) return wait(permit.permitId, finalGate);
      snapshotCheck(snapshot, permit, now());
      // This commits a permanent fence BEFORE the only provider mutation. Never reset it.
      const reservation = await deps.store.reserve(permit, fingerprint, { ...baseline, observedAt: snapshot.observedAt,
        reportingDate: snapshot.reportingDate, spendMinor: snapshot.campaign.spendMinor, aggregateSpendMinor: snapshot.quality.aggregateSpendMinor });
      const operation = reservation.operation;
      if (operation.fingerprint !== fingerprint) throw new CreatorBudgetTestError("PERMIT_REUSE_CONFLICT", 409);
      if (!reservation.created) return result(operation);
      const current = configured();
      if (!deps.enabled() || !current || creatorBudgetTestFingerprint(current) !== fingerprint || gate(permit, now())) {
        return persist(operation, { status: "FAILED_NOT_SENT", providerAccepted: false, observedBudgetMinor: null, reason: "APPROVAL_CLOSED_AFTER_RESERVATION" });
      }
      let providerAccepted: boolean | null = null;
      try {
        // The URL, advertiser, campaign and ONLY mutable field are server-owned.
        const response = await fetchImpl(UPDATE_URL, { method: "POST", redirect: "error",
          headers: { "Access-Token": accessToken, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ advertiser_id: CREATOR_BINDING.advertiserId, campaign_id: permit.campaignId, budget: permit.targetBudgetMinor / 100 }),
          signal: AbortSignal.timeout(8000) });
        const payload = await boundedJson(response);
        if (response.ok && typeof payload.code === "number" && Number.isSafeInteger(payload.code) && payload.code !== 0) {
          return persist(operation, { status: "FAILED_REJECTED", providerAccepted: false, observedBudgetMinor: null, reason: "PROVIDER_REJECTED" });
        }
        if (!response.ok || payload.code !== 0) throw new Error("PROVIDER_OUTCOME_UNKNOWN");
        providerAccepted = true;
        const readBack = infoBaseline(await freshInfo(), permit, now(), permit.targetBudgetMinor);
        if (readBack.targetRoi !== baseline.targetRoi) throw new Error("READBACK_BASELINE_CHANGED");
        return persist(operation, { status: "SUCCEEDED", providerAccepted: true, observedBudgetMinor: permit.targetBudgetMinor, reason: "PROVIDER_ACCEPTED_AND_READBACK_MATCHED" });
      } catch {
        // A timeout or failed read-back is NOT permission to resend or revert a budget.
        return persist(operation, { status: "OUTCOME_UNKNOWN", providerAccepted, observedBudgetMinor: null, reason: "PROVIDER_OUTCOME_REQUIRES_READ_ONLY_RECONCILIATION" });
      }
    },
    async status(permitId: string) { return result(await getOperation(permitId)); },
    async reconcile(permitId: string) {
      const operation = await getOperation(permitId);
      if (["SUCCEEDED", "FAILED_REJECTED", "FAILED_NOT_SENT"].includes(operation.status)) return result(operation);
      try {
        const info = await freshInfo(), observed = minor(info.budget);
        // Reconciliation never writes to TikTok, including when the original POST is delayed.
        infoBaseline(info, operation.permit, now(), observed);
        const target = observed === operation.permit.targetBudgetMinor;
        return persist(operation, { status: target ? (operation.providerAccepted === true ? "SUCCEEDED" : "RECONCILED_TARGET_OBSERVED")
          : observed === operation.permit.expectedBudgetMinor ? "OUTCOME_UNKNOWN" : "CONFLICT_OBSERVED",
          providerAccepted: operation.providerAccepted, observedBudgetMinor: observed,
          reason: target ? (operation.providerAccepted === true ? "PROVIDER_ACCEPTED_AND_READBACK_MATCHED" : "TARGET_OBSERVED_CAUSALITY_UNPROVEN")
            : observed === operation.permit.expectedBudgetMinor ? "BASELINE_OBSERVED_ORIGINAL_REQUEST_MAY_STILL_SETTLE" : "UNEXPECTED_BUDGET_MANUAL_REVIEW_REQUIRED" });
      } catch { return result({ ...operation, reason: "READ_ONLY_RECONCILIATION_UNAVAILABLE" }); }
    },
  };
}
export type CreatorBudgetTestService = ReturnType<typeof createCreatorBudgetTestService>;
