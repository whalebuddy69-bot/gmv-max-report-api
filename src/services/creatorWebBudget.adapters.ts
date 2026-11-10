import { createHash } from "node:crypto";
import { bangkokDay, CREATOR_BINDING, createCreatorReader, createExtraCreatorReader, createPpanManualBudgetReader, minor } from "./creatorRead.service";
import type { AutomationVerifiedCreatorBinding } from "./creatorAutomationRegistry.service";
import { configuredCreatorScheduledAutoLive, configuredCreatorWebBudgetMode, configuredCreatorSpendTrendLive, creatorBudgetPolicyPath,
  allowsScheduledCreatorAuto, isExtraCreatorBudgetScope, isVerifiedRoomCreator, LIVE_ROOM_SPEND_TREND, type CreatorBudgetScope } from "./creatorBudgetScope";
import { createCreatorVerifiedLiveRoomReader } from "./creatorVerifiedLiveRoom.service";
import { roundedCreatorAutoTarget, type CreatorAutoBudgetRounding } from "./creatorAutoBudgetMoney";
import { WEB_BUDGET_MAX_MINOR, WebBudgetError, type WebBudgetAdapters, type WebBudgetContext, type WebBudgetPreArmContext, type WebBudgetRoomEvidence,
  type WebBudgetSource } from "./creatorWebBudget.service";

const POLICY_ORIGIN = "https://whale-buddy-ads-control-plane.onrender.com/internal/automation";
const TIKTOK = "https://business-api.tiktok.com/open_api/v1.3";
const INFO = "/campaign/gmv_max/info/", LIST = "/gmv_max/campaign/get/", UPDATE = "/campaign/gmv_max/update/";
const ID = /^[1-9]\d{5,30}$/;
const UUID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const MAX_BODY = 1_048_576;

type Data = Record<string, unknown>;
type Native = "DISABLED" | "UNKNOWN" | "ENABLED" | "CONFLICT";
type CampaignListObservation = { stamp: string; campaignDeliveryStatus?: WebBudgetContext["campaignDeliveryStatus"] };
type Sample = { budgetMinor: number; stamp: string; unchanged: string; nonRoiSettingsFingerprint: string; fingerprint: string; native: Native;
  scheduleStartAt: string; scheduleEndAt: string | null; campaignDeliveryStatus?: WebBudgetContext["campaignDeliveryStatus"] };
type Policy = Awaited<ReturnType<WebBudgetAdapters["readPolicy"]>>;

function unverified(): never { throw new Error("WEB_BUDGET_ADAPTER_UNVERIFIED"); }
function object(x: unknown): Data { if (!x || typeof x !== "object" || Array.isArray(x)) unverified(); return x as Data; }
function opt(x: unknown): Data { return x == null ? {} : object(x); }
function nonnegative(x: unknown): x is number { return Number.isSafeInteger(x) && Number(x) >= 0; }
function positive(x: unknown): x is number { return nonnegative(x) && x > 0; }
function matchesAutoTarget(baseline: unknown, target: unknown, rounding?: CreatorAutoBudgetRounding) {
  return positive(baseline) && positive(target) && baseline < target && target <= WEB_BUDGET_MAX_MINOR &&
    roundedCreatorAutoTarget(BigInt(baseline), rounding) === BigInt(target);
}
function noShop(x: unknown) { return x == null || x === "" || x === "0"; }
function campaignDeliveryStatus(value: unknown): WebBudgetContext["campaignDeliveryStatus"] {
  if (value === undefined) return undefined;
  if (value === "CAMPAIGN_STATUS_ENABLE") return "ENABLED";
  if (value === "CAMPAIGN_STATUS_BUDGET_EXCEED") return "CAMPAIGN_BUDGET_EXHAUSTED";
  return "OTHER";
}
function validIso(x: unknown): x is string {
  return typeof x === "string" && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
}
function secondsStamp(x: unknown): x is string {
  return typeof x === "string" && DATE_TIME.test(x) && validIso(x.replace(" ", "T") + ".000Z");
}
const utcSecondsIso = (stamp: string) => stamp.replace(" ", "T") + ".000Z";
function fresh(x: unknown, at: number, maxAge: number): x is string {
  return validIso(x) && at >= Date.parse(x) && at - Date.parse(x) <= maxAge;
}
function sorted(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sorted);
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]));
  return x;
}
function hash(x: unknown) { return createHash("sha256").update(JSON.stringify(sorted(x))).digest("hex"); }
function nativeState(data: Data): Native {
  const nested = opt(data.auto_budget);
  const promotion = opt(data.promotion_days);
  const raw = [data.auto_budget_enabled, nested.auto_budget_enabled, nested.is_enabled];
  if (raw.some(x => x != null && x !== true && x !== false) ||
    (promotion.is_enabled != null && promotion.is_enabled !== true && promotion.is_enabled !== false)) return "CONFLICT";
  if (promotion.is_enabled === true) return "ENABLED";
  if (raw.includes(true)) return raw.includes(false) ? "CONFLICT" : "ENABLED";
  return raw.includes(false) ? "DISABLED" : "UNKNOWN";
}

async function json(response: Response, max = MAX_BODY): Promise<Data> {
  if (!response.body || Number(response.headers.get("content-length")) > max) unverified();
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const row = await reader.read();
      if (row.done) break;
      bytes += row.value.byteLength;
      if (bytes > max) { void reader.cancel().catch(() => undefined); unverified(); }
      chunks.push(Buffer.from(row.value));
    }
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally { reader.releaseLock(); }
}

type PolicyClient = CreatorBudgetScope;

function policyView(value: Data, now: Date, clientId: PolicyClient = "punpan_020"): Policy {
  if (value.schemaVersion !== 1 || value.clientId !== clientId || !positive(value.revision) ||
    !positive(value.campaignCapMinor) || !positive(value.clientDailyCapMinor) ||
    value.campaignCapMinor > WEB_BUDGET_MAX_MINOR || value.clientDailyCapMinor > WEB_BUDGET_MAX_MINOR ||
    !fresh(value.readAt, now.getTime(), 15_000) || typeof value.locked !== "boolean") unverified();
  return { revision: value.revision, campaignCapMinor: value.campaignCapMinor,
    clientDailyCapMinor: value.clientDailyCapMinor, readAt: value.readAt, locked: value.locked,
    ...(value.capWriteEnabled === true ? { capWriteEnabled: true } : {}),
    ...(value.autoLineReady === true ? { autoLineReady: true } : {}) };
}

function createPolicyRequest({ fetchImpl, env, clientId }: { fetchImpl: typeof fetch; env: NodeJS.ProcessEnv; clientId: PolicyClient }) {
  const fixedPath = creatorBudgetPolicyPath(clientId);
  if (!fixedPath) unverified();
  const url = POLICY_ORIGIN + fixedPath;
  return async function policyRequest(path: "" | "/lease" | "/finish" | "/cap" | "/check-failure-alert" | `/line-result/${string}`, body?: Data) {
    const key = env.CREATOR_WEB_POLICY_BRIDGE_KEY;
    if (!key || !/^[A-Za-z0-9_-]{43,100}$/.test(key) ||
      [env.CREATOR_READ_BRIDGE_KEY, env.CREATOR_BUDGET_TEST_KEY, env.INTERNAL_API_KEY, env.JWT_SECRET].includes(key)) unverified();
    const response = await fetchImpl(url + path, {
      method: path && !path.startsWith("/line-result/") ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(4500),
      headers: { "X-Creator-Web-Key": key, Accept: "application/json", "Cache-Control": "no-store", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok && !(path === "/cap" && response.status === 409)) unverified();
    const data = await json(response, 4096);
    if (JSON.stringify(data).includes(key)) unverified();
    if (!response.ok) {
      const code = data.code ?? (data.error && typeof data.error === "object" ? (data.error as Data).code : undefined);
      if (code === "POLICY_CHANGED") throw new WebBudgetError("CAP_CHANGED", 409, "เพดานงบเปลี่ยนแล้ว กรุณาตรวจยอดล่าสุดก่อนยืนยันอีกครั้ง");
      if (code === "POLICY_LOCKED") throw new WebBudgetError("CAP_LOCKED", 409, "มีรายการปรับงบที่ต้องตรวจผลก่อนเปลี่ยนเพดาน");
      unverified();
    }
    return data;
  };
}

/** Hand off a durable check incident; an acknowledgement is not a delivery receipt. */
export async function queueCreatorAutoCheckFailureAlert(clientId: PolicyClient, input: {
  incidentId: string; advertiserName: string; tiktokUsername: string;
}, fetchImpl = fetch, env = process.env) {
  const { incidentId, advertiserName, tiktokUsername } = input;
  if (!UUID.test(incidentId) || typeof advertiserName !== "string" || !advertiserName || advertiserName.length > 120 ||
    advertiserName.trim() !== advertiserName || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(advertiserName) ||
    typeof tiktokUsername !== "string" || !/^[a-z0-9._]{1,40}$/.test(tiktokUsername)) unverified();
  const reply = await createPolicyRequest({ fetchImpl, env, clientId })("/check-failure-alert", { incidentId, advertiserName, tiktokUsername, failedChecks: 10 });
  if (reply.schemaVersion !== 1 || reply.clientId !== clientId || reply.incidentId !== incidentId ||
    !["PENDING", "ACCEPTED", "UNCONFIRMED", "EXPIRED"].includes(String(reply.status))) unverified();
}

export async function readPpanAutoLineStatus(operationId: string, fetchImpl = fetch, env = process.env) {
  if (!UUID.test(operationId)) unverified();
  const raw = await createPolicyRequest({ fetchImpl, env, clientId: "punpan_020" })(`/line-result/${operationId}`);
  const status = raw.status;
  if (raw.schemaVersion !== 1 || raw.clientId !== "punpan_020" || raw.operationId !== operationId ||
    (status !== "PENDING" && status !== "ACCEPTED" && status !== "UNCONFIRMED" && status !== "UNKNOWN")) unverified();
  return status;
}

export function createCreatorWebCapAdapters({ fetchImpl = fetch, now = () => new Date(), env = process.env }:
  { fetchImpl?: typeof fetch; now?: () => Date; env?: NodeJS.ProcessEnv } = {}) {
  async function status(clientId: PolicyClient) {
    const raw = await createPolicyRequest({ fetchImpl, env, clientId })("");
    if (clientId !== "punpan_020" && raw.configured === false) {
      if (raw.schemaVersion !== 1 || raw.clientId !== clientId || raw.locked !== false ||
        raw.revision !== undefined || raw.campaignCapMinor !== undefined || raw.clientDailyCapMinor !== undefined ||
        !fresh(raw.readAt, now().getTime(), 15_000)) unverified();
      return { cap: null, capEditAllowed: raw.capWriteEnabled === true };
    }
    if (clientId !== "punpan_020" && raw.configured !== true) unverified();
    const cap = policyView(raw, now(), clientId);
    return { cap, capEditAllowed: cap.capWriteEnabled === true && !cap.locked && cap.campaignCapMinor === cap.clientDailyCapMinor };
  }
  return {
    status,
    async update(clientId: PolicyClient, actorUserId: number, expectedRevision: number, capMinor: number, recheck: () => Promise<boolean>) {
      if (!positive(actorUserId) || !nonnegative(expectedRevision) || expectedRevision >= Number.MAX_SAFE_INTEGER ||
        (clientId === "punpan_020" && expectedRevision === 0) || !positive(capMinor) || capMinor > WEB_BUDGET_MAX_MINOR) {
        throw new WebBudgetError("CAP_INPUT_INVALID", 400, "จำนวนเงินหรือข้อมูลเพดานไม่ถูกต้อง");
      }
      try {
        const state = await status(clientId);
        if ((state.cap?.revision ?? 0) !== expectedRevision) throw new WebBudgetError("CAP_CHANGED", 409, "เพดานงบเปลี่ยนแล้ว กรุณาตรวจยอดล่าสุด");
        if (state.cap?.locked) throw new WebBudgetError("CAP_LOCKED", 409, "มีรายการปรับงบที่ต้องตรวจผลก่อนเปลี่ยนเพดาน");
        if (!state.capEditAllowed) throw new WebBudgetError("CAP_EDIT_DISABLED", 403, "ยังไม่ได้เปิดให้ตั้งเพดานจากเว็บ");
        if (state.cap?.campaignCapMinor === capMinor) throw new WebBudgetError("CAP_NO_CHANGE", 400, "เพดานใหม่ต้องต่างจากเพดานปัจจุบัน");
        if (!await recheck()) throw new WebBudgetError("BUDGET_OPERATOR_DENIED", 403, "บัญชีนี้ยังไม่ได้รับสิทธิ์สั่งงบ");
        const raw = await createPolicyRequest({ fetchImpl, env, clientId })("/cap", { revision: expectedRevision, capMinor, actorUserId });
        const actual = policyView(raw, now(), clientId);
        if (actual.revision !== expectedRevision + 1 || actual.campaignCapMinor !== capMinor || actual.clientDailyCapMinor !== capMinor ||
          (clientId !== "punpan_020" && raw.configured !== true)) unverified();
        return { capMinor, revision: actual.revision };
      } catch (error) {
        if (error instanceof WebBudgetError) throw error;
        throw new WebBudgetError("CAP_UPDATE_UNCONFIRMED", 503, "ยังยืนยันผลการเปลี่ยนเพดานไม่ได้ กรุณาโหลดเพดานล่าสุดก่อนส่งอีกครั้ง");
      }
    },
  };
}

/** Server-side only. No browser-controlled URLs, advertiser IDs, tokens, or mutation payloads. */
export function createCreatorWebBudgetAdapters({ loadToken, fetchImpl = fetch, now = () => new Date(),
  env = process.env, sleep, extraBinding }: {loadToken: () => Promise<string>; fetchImpl?: typeof fetch; now?: () => Date;
  env?: NodeJS.ProcessEnv; sleep?: (ms: number) => Promise<void>; extraBinding?: AutomationVerifiedCreatorBinding}): WebBudgetAdapters {
  const extraClient = extraBinding?.clientId;
  if (extraBinding && (!isExtraCreatorBudgetScope(extraClient) || extraBinding.advertiserId === CREATOR_BINDING.advertiserId ||
    extraBinding.identityId === CREATOR_BINDING.identityId || extraBinding.identityType !== "BC_AUTH_TT")) unverified();
  const clientId: PolicyClient = isExtraCreatorBudgetScope(extraClient) ? extraClient : "punpan_020";
  const binding = extraBinding ?? CREATOR_BINDING;
  const policyRequest = createPolicyRequest({ fetchImpl, env, clientId });
  const readRoom = createCreatorVerifiedLiveRoomReader({ advertiserId: binding.advertiserId, identity: binding, fetchImpl, now });
  function checkedPolicy(raw: Data, at: Date) {
    if (extraBinding && raw.configured !== true) unverified();
    return policyView(raw, at, clientId);
  }
  async function token() {
    const value = await loadToken();
    if (typeof value !== "string" || !/^[^\x00-\x20\x7f]{16,4096}$/.test(value)) unverified();
    return value;
  }

  async function getTikTokData(url: URL, accessToken: string) {
    const r = await fetchImpl(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { "Access-Token": accessToken, Accept: "application/json", "Cache-Control": "no-cache" } });
    const j = await json(r);
    if (!r.ok || j.code !== 0) unverified();
    return object(j.data);
  }

  async function providerGet(path: typeof INFO | typeof LIST, campaignId: string, accessToken: string) {
    if (!ID.test(campaignId) || (path !== INFO && path !== LIST)) unverified();
    const url = new URL(TIKTOK + path);
    url.searchParams.set("advertiser_id", binding.advertiserId);
    if (path === INFO) url.searchParams.set("campaign_id", campaignId);
    else {
      url.searchParams.set("filtering", JSON.stringify({ gmv_max_promotion_types: ["LIVE_GMV_MAX"], campaign_ids: [campaignId] }));
      url.searchParams.set("fields", JSON.stringify(["advertiser_id", "campaign_id", "operation_status", "modify_time", "secondary_status"]));
      url.searchParams.set("page", "1"); url.searchParams.set("page_size", "100");
    }
    return getTikTokData(url, accessToken);
  }

  async function exactCampaignList(campaignId: string, accessToken: string, allowInactive = false): Promise<CampaignListObservation | null> {
    const list = await providerGet(LIST, campaignId, accessToken);
    const page = object(list.page_info);
    if (!Array.isArray(list.list) || page.page !== 1 || (allowInactive &&
      ((list.advertiser_id !== undefined && list.advertiser_id !== binding.advertiserId) ||
       (page.page_size !== undefined && page.page_size !== 100)))) unverified();
    if (allowInactive && list.list.length === 0 && page.total_number === 0 && (page.total_page === 0 || page.total_page === 1)) return null;
    if (list.list.length !== 1 || page.total_page !== 1 || page.total_number !== 1) unverified();
    const row = object(list.list[0]);
    if (row.advertiser_id !== binding.advertiserId || row.campaign_id !== campaignId) unverified();
    if (allowInactive && (row.operation_status === "DISABLE" || row.operation_status === "DELETE")) return null;
    if (row.operation_status !== "ENABLE" || !secondsStamp(row.modify_time)) unverified();
    const delivery = campaignDeliveryStatus(row.secondary_status);
    return { stamp: row.modify_time, ...(delivery === undefined ? {} : { campaignDeliveryStatus: delivery }) };
  }

  async function sample(campaignId: string, accessToken: string, { preArmStamp, strictIdentity = false }: {
    preArmStamp?: string; strictIdentity?: boolean;
  } = {}): Promise<Sample> {
    const data = await providerGet(INFO, campaignId, accessToken);
    const verifyRoomIdentity = isVerifiedRoomCreator(clientId) || strictIdentity || preArmStamp !== undefined;
    if (data.advertiser_id !== binding.advertiserId || data.campaign_id !== campaignId ||
      data.shopping_ads_type !== "LIVE" || data.operation_status !== "ENABLE" || data.store_id !== "0" ||
      data.store_authorized_bc_id !== "0" || ((!extraBinding || verifyRoomIdentity) && data.tiktok_account_id !== undefined && data.tiktok_account_id !== binding.tiktokAccountId) ||
      !Array.isArray(data.identity_list) || data.identity_list.length !== 1 ||
      data.optimization_goal !== "VALUE" || data.deep_bid_type !== "VO_MIN_ROAS" ||
      typeof data.roas_bid !== "number" || !Number.isFinite(data.roas_bid) || data.roas_bid <= 0) unverified();
    const identity = object(data.identity_list[0]);
    if (identity.identity_id !== binding.identityId || identity.identity_type !== binding.identityType ||
      identity.identity_authorized_bc_id !== binding.identityAuthorizedBcId ||
      (verifyRoomIdentity && identity.tiktok_account_id !== undefined && identity.tiktok_account_id !== binding.tiktokAccountId) ||
      !noShop(identity.store_id) || !noShop(identity.identity_authorized_shop_id)) unverified();
    const at = now().getTime();
    const start = data.schedule_start_time, end = data.schedule_end_time;
    const hasFixedEnd = ["START_END", "SCHEDULE_START_END"].includes(String(data.schedule_type));
    if ((!hasFixedEnd && !["FROM_NOW", "SCHEDULE_FROM_NOW"].includes(String(data.schedule_type))) || !secondsStamp(start) ||
      ((end != null || hasFixedEnd) && !secondsStamp(end))) unverified();
    const scheduleStartAt = utcSecondsIso(start), scheduleEndAt = secondsStamp(end) ? utcSecondsIso(end) : null;
    if ((scheduleEndAt !== null && scheduleEndAt <= scheduleStartAt) || (preArmStamp === undefined &&
      (Date.parse(scheduleStartAt) > at || (scheduleEndAt !== null && Date.parse(scheduleEndAt) <= at)))) unverified();
    if (preArmStamp !== undefined && data.modify_time !== undefined && data.modify_time !== preArmStamp) unverified();
    // Only campaign settings are stable across a manual budget edit. A
    // secondary delivery status, if the detail endpoint echoes it, is runtime
    // evidence and must not turn an unchanged campaign into a settings edit.
    const { budget, modify_time: _, secondary_status: _delivery, ...untouched } = data;
    const budgetMinor = minor(budget);
    if (!positive(budgetMinor)) unverified();
    const listed: CampaignListObservation | null = preArmStamp === undefined ? await exactCampaignList(campaignId, accessToken) : { stamp: preArmStamp };
    if (listed === null) unverified();
    const { stamp, campaignDeliveryStatus: delivery } = listed;
    const native = nativeState(data), unchanged = hash(untouched);
    // Preserve the exact existing writer/readback fingerprint. The separate
    // persistent-session evidence excludes only the validated top-level ROI.
    const { roas_bid: _roi, ...nonRoiSettings } = untouched;
    const nonRoiSettingsFingerprint = hash(nonRoiSettings);
    // Delivery is provider-derived and can change without any campaign edit.
    return { budgetMinor, stamp, unchanged, nonRoiSettingsFingerprint, native, fingerprint: hash([budgetMinor, stamp, unchanged]), scheduleStartAt, scheduleEndAt,
      ...(delivery === undefined ? {} : { campaignDeliveryStatus: delivery }) };
  }

  async function verifyAdvertiser(accessToken: string) {
    const url = new URL(TIKTOK + "/advertiser/info/");
    url.searchParams.set("advertiser_ids", JSON.stringify([binding.advertiserId]));
    url.searchParams.set("fields", JSON.stringify(["advertiser_id", "currency", "timezone"]));
    const metadata = await getTikTokData(url, accessToken);
    if ((metadata.advertiser_id !== undefined && metadata.advertiser_id !== binding.advertiserId) ||
      !Array.isArray(metadata.list) || metadata.list.length !== 1) unverified();
    const advertiser = object(metadata.list[0]);
    if (advertiser.advertiser_id !== binding.advertiserId || advertiser.currency !== "THB" || advertiser.timezone !== "Asia/Bangkok") unverified();
  }

  function checkScheduledScope(expectedCampaignId: string, expectedLiveSessionId?: string) {
    if (!allowsScheduledCreatorAuto(clientId) || env.CREATOR_READ_ENABLED !== "true" ||
      typeof expectedCampaignId !== "string" || !ID.test(expectedCampaignId) ||
      (expectedLiveSessionId !== undefined && (typeof expectedLiveSessionId !== "string" || !ID.test(expectedLiveSessionId)))) unverified();
  }

  async function preArmContext(expectedCampaignId: string, accessToken: string, startedAt: string): Promise<WebBudgetPreArmContext | null> {
    const reportingDate = bangkokDay(new Date(startedAt));
    await verifyAdvertiser(accessToken);
    const listed = await exactCampaignList(expectedCampaignId, accessToken, true);
    const live = listed === null ? null : await sample(expectedCampaignId, accessToken, { preArmStamp: listed.stamp });
    const observed = now();
    if (!fresh(startedAt, observed.getTime(), 20_000) || bangkokDay(observed) !== reportingDate) unverified();
    if (!live || (live.scheduleEndAt !== null && Date.parse(live.scheduleEndAt) <= observed.getTime())) return null;
    if (live.budgetMinor > WEB_BUDGET_MAX_MINOR) unverified();
    return { campaignId: expectedCampaignId, reportingDate, observedAt: observed.toISOString(), budgetMinor: live.budgetMinor,
      fingerprint: live.fingerprint, settingsFingerprint: live.unchanged, nonRoiSettingsFingerprint: live.nonRoiSettingsFingerprint, nativeAutoState: live.native,
      scheduleStartAt: live.scheduleStartAt, scheduleEndAt: live.scheduleEndAt };
  }

  async function readPreArmContext(expectedCampaignId: string): Promise<WebBudgetPreArmContext | null> {
    checkScheduledScope(expectedCampaignId);
    const startedAt = now().toISOString();
    return preArmContext(expectedCampaignId, await token(), startedAt);
  }

  async function readAutoDetectContext(expectedCampaignId: string, expectedLiveSessionId?: string): Promise<(WebBudgetPreArmContext & WebBudgetRoomEvidence) | null> {
    checkScheduledScope(expectedCampaignId, expectedLiveSessionId);
    const startedAt = now().toISOString(), accessToken = await token();
    const stat = await preArmContext(expectedCampaignId, accessToken, startedAt);
    if (!stat) return null;
    if (Date.parse(stat.scheduleStartAt) > now().getTime()) return stat;
    const room = await readRoom({ advertiserId: binding.advertiserId, campaignId: expectedCampaignId, accessToken,
      reportingDate: stat.reportingDate, expectedLiveSessionId, autoDetectLive: true });
    const at = now();
    if (bangkokDay(at) !== stat.reportingDate || !fresh(stat.observedAt, at.getTime(), 25_000)) unverified();
    return { ...stat, ...room };
  }

  async function context(expectedCampaignId: string, accessToken: string, source?: WebBudgetSource, forceRoom = false,
    expectedLiveSessionId?: string, autoDetectLive?: true) {
    if (forceRoom && (!allowsScheduledCreatorAuto(clientId) || source === "manual")) unverified();
    // The pinned pilot's default reader skips advertiser metadata; a new
    // room-based path explicitly proves the timezone used by the room report.
    if (forceRoom && !extraBinding) await verifyAdvertiser(accessToken);
    const deps = { loadToken: async () => accessToken, fetchImpl, now, sleep };
    const read = extraBinding ? createExtraCreatorReader(deps, clientId, extraBinding)
      : source === "manual" ? createPpanManualBudgetReader(deps) : createCreatorReader(deps);
    const raw = await read();
    const c = object(raw.campaign), quality = object(raw.quality);
    if (c.campaignId !== expectedCampaignId || quality.aggregateSpendComplete !== true ||
      !nonnegative(c.spendMinor) || !nonnegative(quality.aggregateSpendMinor) || quality.aggregateSpendMinor < c.spendMinor) unverified();
    const live = await sample(expectedCampaignId, accessToken, { strictIdentity: forceRoom });
    const at = now();
    if (raw.reportingDate !== bangkokDay(at) || !fresh(raw.observedAt, at.getTime(), 25_000) || c.dailyBudgetMinor !== live.budgetMinor) unverified();
    // Room evidence is separate from the spend read. Do not manufacture a
    // provider spend watermark or equate an enabled campaign with a LIVE.
    const room = forceRoom || (isVerifiedRoomCreator(clientId) && source !== "manual") ? await readRoom({ advertiserId: binding.advertiserId,
      campaignId: expectedCampaignId, accessToken, reportingDate: raw.reportingDate, expectedLiveSessionId, autoDetectLive }) :
      { deliveryVerified: false, liveDeliveryState: "UNKNOWN" as const, liveSessionId: null };
    return { campaignId: expectedCampaignId, reportingDate: raw.reportingDate as string, observedAt: raw.observedAt,
      budgetMinor: live.budgetMinor, spendMinor: c.spendMinor, aggregateSpendMinor: quality.aggregateSpendMinor,
      fingerprint: live.fingerprint, settingsFingerprint: live.unchanged, nonRoiSettingsFingerprint: live.nonRoiSettingsFingerprint,
      nativeAutoState: live.native, providerSpendObservedAt: null,
      ...(live.campaignDeliveryStatus === undefined ? {} : { campaignDeliveryStatus: live.campaignDeliveryStatus }), ...room, sample: live };
  }

  async function readScheduledLiveContext(expectedCampaignId: string, expectedLiveSessionId?: string, autoDetectLive?: true) {
    checkScheduledScope(expectedCampaignId, expectedLiveSessionId);
    if (autoDetectLive !== undefined && autoDetectLive !== true) unverified();
    const { sample: _, ...result } = await context(expectedCampaignId, await token(), undefined, true, expectedLiveSessionId, autoDetectLive);
    return result;
  }

  return {
    async readPolicy() { return checkedPolicy(await policyRequest(""), now()); },
    ...(allowsScheduledCreatorAuto(clientId) ? { readPreArmContext, readScheduledLiveContext, readAutoDetectContext } : {}),
    async acquireLease(operationId, revision, autoBudget) {
      if (!UUID.test(operationId) || !positive(revision)) unverified();
      if (autoBudget) {
        const rounding = autoBudget.rounding;
        if ((rounding !== undefined && (rounding === "ceil-baht" ? !configuredCreatorScheduledAutoLive(env, clientId)
          : rounding !== "floor-satang" || clientId !== "punpan_020")) ||
          !matchesAutoTarget(autoBudget.previousBudgetMinor, autoBudget.targetBudgetMinor, rounding)) unverified();
      }
      const raw = await policyRequest("/lease", { operationId, revision, ...(autoBudget ? { autoBudget } : {}) });
      const at = now();
      const view = checkedPolicy(raw, at);
      if (!view.locked || view.revision !== revision || raw.operationId !== operationId || !validIso(raw.expiresAt) ||
        Date.parse(raw.expiresAt) <= at.getTime() || Date.parse(raw.expiresAt) - at.getTime() > 65_000) unverified();
      return { ...view, operationId, expiresAt: raw.expiresAt };
    },
    async finishLease(operationId, outcome) {
      if (!UUID.test(operationId) || !["NOT_SENT", "PROVIDER_REJECTED", "APPLIED_VERIFIED", "OUTCOME_UNKNOWN"].includes(outcome)) unverified();
      const raw = await policyRequest("/finish", { operationId, outcome });
      if (raw.schemaVersion !== 1 || raw.operationId !== operationId || raw.outcome !== outcome ||
        raw.locked !== (outcome === "OUTCOME_UNKNOWN")) unverified();
    },
    async readContext(expectedCampaignId, source) {
      if (env.CREATOR_READ_ENABLED !== "true" || !ID.test(expectedCampaignId)) unverified();
      const { sample: _, ...result } = await context(expectedCampaignId, await token(), source);
      return result;
    },
    async dispatch(input) {
      let attempted = false;
      try {
        const roomTrend = input.evidenceMode === LIVE_ROOM_SPEND_TREND;
        if (input.autoDetectLive !== undefined && (input.autoDetectLive !== true || !roomTrend)) unverified();
        const rounding = input.autoRounding;
        if (rounding !== undefined && (input.source !== "auto" || (rounding === "ceil-baht"
          ? !roomTrend || !configuredCreatorScheduledAutoLive(env, clientId)
          : rounding !== "floor-satang" || clientId !== "punpan_020" || roomTrend))) unverified();
        const allowedAuthority = input.evidenceMode === "spend-trend" ? configuredCreatorSpendTrendLive(env, clientId) &&
          input.nativeAutoOff === undefined && input.noConcurrentChanges === undefined &&
          matchesAutoTarget(input.expectedBudgetMinor, input.targetBudgetMinor, clientId === "punpan_020" ? "floor-satang" : undefined)
          : input.nativeAutoOff === true && input.noConcurrentChanges === true && (roomTrend ?
            input.source === "auto" && configuredCreatorScheduledAutoLive(env, clientId) &&
            matchesAutoTarget(input.expectedBudgetMinor, input.targetBudgetMinor, rounding) :
            input.evidenceMode === undefined && !(input.source === "auto" && isVerifiedRoomCreator(clientId)));
        if (configuredCreatorWebBudgetMode(env, clientId) !== "live" ||
          !allowedAuthority || !ID.test(input.campaignId) ||
          !positive(input.expectedBudgetMinor) || !positive(input.targetBudgetMinor) || input.expectedBudgetMinor === input.targetBudgetMinor ||
          !positive(input.campaignCapMinor) || !positive(input.clientDailyCapMinor) || input.targetBudgetMinor > input.campaignCapMinor ||
          !/^[a-f0-9]{64}$/.test(input.fingerprint) || !validIso(input.notAfter)) unverified();
        const accessToken = await token();
        const latest = await context(input.campaignId, accessToken, input.evidenceMode === undefined ? input.source : undefined,
          roomTrend, undefined, input.autoDetectLive);
        const before = latest.sample;
        if (await input.canSend(latest) !== true) unverified();
        const at = now();
        if ((input.evidenceMode === "spend-trend" && !configuredCreatorSpendTrendLive(env, clientId)) || bangkokDay(at) !== input.reportingDate || latest.reportingDate !== input.reportingDate ||
          (roomTrend && (!configuredCreatorScheduledAutoLive(env, clientId) || latest.deliveryVerified !== true ||
            latest.liveDeliveryState !== "LIVE" || !latest.liveSessionId || !validIso(latest.liveSessionStartedAt) ||
            (input.autoDetectLive === true && !nonnegative(latest.roomSpendMinor)))) ||
          Date.parse(input.notAfter) - at.getTime() < 10_000 || !fresh(latest.observedAt, at.getTime(), 25_000) ||
          before.budgetMinor !== input.expectedBudgetMinor || before.fingerprint !== input.fingerprint ||
          !["DISABLED", "UNKNOWN"].includes(before.native) || input.targetBudgetMinor <= latest.spendMinor ||
          BigInt(input.targetBudgetMinor) + BigInt(latest.aggregateSpendMinor - latest.spendMinor) > BigInt(input.clientDailyCapMinor)) unverified();
        // Exactly one provider POST, with only the proven budget field. Never retry.
        attempted = true;
        const r = await fetchImpl(TIKTOK + UPDATE, { method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
          headers: { "Access-Token": accessToken, Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ advertiser_id: binding.advertiserId, campaign_id: input.campaignId, budget: input.targetBudgetMinor / 100 }) });
        const result = await json(r);
        // An HTTP or nonzero provider response is not a documented no-write
        // guarantee for this Creator endpoint. Preserve the fence after any
        // ambiguous POST instead of trusting an immediately stale readback.
        if (!r.ok || result.code !== 0) unverified();
        const data = opt(result.data);
        if ((data.campaign_id !== undefined && data.campaign_id !== input.campaignId) ||
          (data.advertiser_id !== undefined && data.advertiser_id !== binding.advertiserId)) unverified();
        const first = await sample(input.campaignId, accessToken, { strictIdentity: roomTrend });
        const second = await sample(input.campaignId, accessToken, { strictIdentity: roomTrend });
        if (first.budgetMinor !== input.targetBudgetMinor || second.budgetMinor !== input.targetBudgetMinor ||
          first.unchanged !== before.unchanged || second.fingerprint !== first.fingerprint) unverified();
        return { outcome: "APPLIED_VERIFIED", observedBudgetMinor: second.budgetMinor, observedFingerprint: second.fingerprint };
      } catch { return { outcome: attempted ? "OUTCOME_UNKNOWN" : "NOT_SENT" }; }
    },
  };
}
