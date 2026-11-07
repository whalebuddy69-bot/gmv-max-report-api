import { createHash } from "node:crypto";
import { bangkokDay, CREATOR_BINDING, createCreatorReader, createExtraCreatorReader, minor } from "./creatorRead.service";
import type { AutomationVerifiedCreatorBinding } from "./creatorAutomationRegistry.service";
import { WEB_BUDGET_MAX_MINOR, WebBudgetError, type WebBudgetAdapters } from "./creatorWebBudget.service";

const POLICY_ORIGIN = "https://whale-buddy-ads-control-plane.onrender.com/internal/automation";
const TIKTOK = "https://business-api.tiktok.com/open_api/v1.3";
const INFO = "/campaign/gmv_max/info/", LIST = "/gmv_max/campaign/get/", UPDATE = "/campaign/gmv_max/update/";
const ID = /^[1-9]\d{5,30}$/;
const UUID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const MAX_BODY = 1_048_576;

type Data = Record<string, unknown>;
type Native = "DISABLED" | "UNKNOWN" | "ENABLED" | "CONFLICT";
type Sample = { budgetMinor: number; stamp: string; unchanged: string; fingerprint: string; native: Native };
type Policy = Awaited<ReturnType<WebBudgetAdapters["readPolicy"]>>;

function unverified(): never { throw new Error("WEB_BUDGET_ADAPTER_UNVERIFIED"); }
function object(x: unknown): Data { if (!x || typeof x !== "object" || Array.isArray(x)) unverified(); return x as Data; }
function opt(x: unknown): Data { return x == null ? {} : object(x); }
function nonnegative(x: unknown): x is number { return Number.isSafeInteger(x) && Number(x) >= 0; }
function positive(x: unknown): x is number { return nonnegative(x) && x > 0; }
function noShop(x: unknown) { return x == null || x === "" || x === "0"; }
function validIso(x: unknown): x is string {
  return typeof x === "string" && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
}
function secondsStamp(x: unknown): x is string {
  return typeof x === "string" && DATE_TIME.test(x) && validIso(x.replace(" ", "T") + ".000Z");
}
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

type PolicyClient = "punpan_020" | "srihiw";

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
  const url = POLICY_ORIGIN + (clientId === "punpan_020" ? "/ppan/policy" : "/srihiw/policy");
  return async function policyRequest(path: "" | "/lease" | "/finish" | "/cap", body?: Data) {
    const key = env.CREATOR_WEB_POLICY_BRIDGE_KEY;
    if (!key || !/^[A-Za-z0-9_-]{43,100}$/.test(key) ||
      [env.CREATOR_READ_BRIDGE_KEY, env.CREATOR_BUDGET_TEST_KEY, env.INTERNAL_API_KEY, env.JWT_SECRET].includes(key)) unverified();
    const response = await fetchImpl(url + path, {
      method: path ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(4500),
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

export function createCreatorWebCapAdapters({ fetchImpl = fetch, now = () => new Date(), env = process.env }:
  { fetchImpl?: typeof fetch; now?: () => Date; env?: NodeJS.ProcessEnv } = {}) {
  async function status(clientId: PolicyClient) {
    const raw = await createPolicyRequest({ fetchImpl, env, clientId })("");
    if (clientId === "srihiw" && raw.configured === false) {
      if (raw.schemaVersion !== 1 || raw.clientId !== clientId || raw.locked !== false ||
        raw.revision !== undefined || raw.campaignCapMinor !== undefined || raw.clientDailyCapMinor !== undefined ||
        !fresh(raw.readAt, now().getTime(), 15_000)) unverified();
      return { cap: null, capEditAllowed: raw.capWriteEnabled === true };
    }
    if (clientId === "srihiw" && raw.configured !== true) unverified();
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
          (clientId === "srihiw" && raw.configured !== true)) unverified();
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
  if (extraBinding && (extraBinding.clientId !== "srihiw" || extraBinding.advertiserId === CREATOR_BINDING.advertiserId ||
    extraBinding.identityId === CREATOR_BINDING.identityId || extraBinding.identityType !== "BC_AUTH_TT")) unverified();
  const clientId: PolicyClient = extraBinding ? "srihiw" : "punpan_020";
  const binding = extraBinding ?? CREATOR_BINDING;
  const policyRequest = createPolicyRequest({ fetchImpl, env, clientId });
  function checkedPolicy(raw: Data, at: Date) {
    if (extraBinding && raw.configured !== true) unverified();
    return policyView(raw, at, clientId);
  }
  async function token() {
    const value = await loadToken();
    if (typeof value !== "string" || !/^[^\x00-\x20\x7f]{16,4096}$/.test(value)) unverified();
    return value;
  }

  async function providerGet(path: typeof INFO | typeof LIST, campaignId: string, accessToken: string) {
    if (!ID.test(campaignId) || (path !== INFO && path !== LIST)) unverified();
    const url = new URL(TIKTOK + path);
    url.searchParams.set("advertiser_id", binding.advertiserId);
    if (path === INFO) url.searchParams.set("campaign_id", campaignId);
    else {
      url.searchParams.set("filtering", JSON.stringify({ gmv_max_promotion_types: ["LIVE_GMV_MAX"], campaign_ids: [campaignId] }));
      url.searchParams.set("fields", JSON.stringify(["advertiser_id", "campaign_id", "operation_status", "modify_time"]));
      url.searchParams.set("page", "1"); url.searchParams.set("page_size", "100");
    }
    const r = await fetchImpl(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { "Access-Token": accessToken, Accept: "application/json", "Cache-Control": "no-cache" } });
    const j = await json(r);
    if (!r.ok || j.code !== 0) unverified();
    return object(j.data);
  }

  async function sample(campaignId: string, accessToken: string): Promise<Sample> {
    const data = await providerGet(INFO, campaignId, accessToken);
    if (data.advertiser_id !== binding.advertiserId || data.campaign_id !== campaignId ||
      data.shopping_ads_type !== "LIVE" || data.operation_status !== "ENABLE" || data.store_id !== "0" ||
      data.store_authorized_bc_id !== "0" || (!extraBinding && data.tiktok_account_id !== undefined && data.tiktok_account_id !== binding.tiktokAccountId) ||
      !Array.isArray(data.identity_list) || data.identity_list.length !== 1 ||
      data.optimization_goal !== "VALUE" || data.deep_bid_type !== "VO_MIN_ROAS" ||
      typeof data.roas_bid !== "number" || !Number.isFinite(data.roas_bid) || data.roas_bid <= 0) unverified();
    const identity = object(data.identity_list[0]);
    if (identity.identity_id !== binding.identityId || identity.identity_type !== binding.identityType ||
      identity.identity_authorized_bc_id !== binding.identityAuthorizedBcId ||
      !noShop(identity.store_id) || !noShop(identity.identity_authorized_shop_id)) unverified();
    const at = now().getTime();
    const start = data.schedule_start_time, end = data.schedule_end_time;
    if (!["FROM_NOW", "SCHEDULE_FROM_NOW", "START_END", "SCHEDULE_START_END"].includes(String(data.schedule_type)) ||
      !secondsStamp(start) || Date.parse(start.replace(" ", "T") + "Z") > at ||
      ((end != null || ["START_END", "SCHEDULE_START_END"].includes(String(data.schedule_type))) &&
        (!secondsStamp(end) || Date.parse(end.replace(" ", "T") + "Z") <= at))) unverified();
    const { budget, modify_time: _, ...untouched } = data;
    const budgetMinor = minor(budget);
    if (!positive(budgetMinor)) unverified();
    const list = await providerGet(LIST, campaignId, accessToken);
    const page = object(list.page_info);
    if (!Array.isArray(list.list) || list.list.length !== 1 || page.page !== 1 || page.total_page !== 1 || page.total_number !== 1) unverified();
    const row = object(list.list[0]);
    if (row.advertiser_id !== binding.advertiserId || row.campaign_id !== campaignId || row.operation_status !== "ENABLE" || !secondsStamp(row.modify_time)) unverified();
    const native = nativeState(data), unchanged = hash(untouched);
    return { budgetMinor, stamp: row.modify_time, unchanged, native, fingerprint: hash([budgetMinor, row.modify_time, unchanged]) };
  }

  async function context(expectedCampaignId: string, accessToken: string) {
    const deps = { loadToken: async () => accessToken, fetchImpl, now, sleep };
    const raw = await (extraBinding ? createExtraCreatorReader(deps, clientId, extraBinding) : createCreatorReader(deps))();
    const c = object(raw.campaign), quality = object(raw.quality);
    const live = await sample(expectedCampaignId, accessToken);
    const at = now();
    if (raw.reportingDate !== bangkokDay(at) || !fresh(raw.observedAt, at.getTime(), 25_000) ||
      c.campaignId !== expectedCampaignId || c.dailyBudgetMinor !== live.budgetMinor || quality.aggregateSpendComplete !== true ||
      !nonnegative(c.spendMinor) || !nonnegative(quality.aggregateSpendMinor) || quality.aggregateSpendMinor < c.spendMinor) unverified();
    // The currently verified Creator report has no provider timestamp for
    // today's spend and ENABLE is not proof that a LIVE is delivering. Do
    // not substitute fetch time, campaign modification time or a default.
    return { campaignId: expectedCampaignId, reportingDate: raw.reportingDate as string, observedAt: raw.observedAt,
      budgetMinor: live.budgetMinor, spendMinor: c.spendMinor, aggregateSpendMinor: quality.aggregateSpendMinor,
      fingerprint: live.fingerprint, nativeAutoState: live.native, providerSpendObservedAt: null, deliveryVerified: false, sample: live };
  }

  return {
    async readPolicy() { return checkedPolicy(await policyRequest(""), now()); },
    async acquireLease(operationId, revision, autoBudget) {
      if (!UUID.test(operationId) || !positive(revision)) unverified();
      if (autoBudget && (!positive(autoBudget.previousBudgetMinor) || !positive(autoBudget.targetBudgetMinor) ||
        BigInt(autoBudget.previousBudgetMinor) * 6n !== BigInt(autoBudget.targetBudgetMinor) * 5n)) unverified();
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
    async readContext(expectedCampaignId) {
      if (env.CREATOR_READ_ENABLED !== "true" || !ID.test(expectedCampaignId)) unverified();
      const { sample: _, ...result } = await context(expectedCampaignId, await token());
      return result;
    },
    async dispatch(input) {
      let attempted = false;
      try {
        if (env.CREATOR_READ_ENABLED !== "true" || (extraBinding ? env.CREATOR_WEB_SRIHIW_BUDGET_MODE : env.CREATOR_WEB_BUDGET_MODE) !== "live" ||
          env.CREATOR_WEB_BUDGET_LIVE_ENABLED !== "true" || env.CREATOR_BUDGET_TEST_ENABLED === "true" ||
          (extraBinding && env.CREATOR_WEB_SRIHIW_BUDGET_LIVE_ENABLED !== "true") ||
          input.nativeAutoOff !== true || input.noConcurrentChanges !== true || !ID.test(input.campaignId) ||
          !positive(input.expectedBudgetMinor) || !positive(input.targetBudgetMinor) || input.expectedBudgetMinor === input.targetBudgetMinor ||
          !positive(input.campaignCapMinor) || !positive(input.clientDailyCapMinor) || input.targetBudgetMinor > input.campaignCapMinor ||
          !/^[a-f0-9]{64}$/.test(input.fingerprint) || !validIso(input.notAfter)) unverified();
        const accessToken = await token();
        const latest = await context(input.campaignId, accessToken);
        const before = latest.sample;
        if (await input.canSend(latest) !== true) unverified();
        const at = now();
        if (bangkokDay(at) !== input.reportingDate || latest.reportingDate !== input.reportingDate ||
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
        const first = await sample(input.campaignId, accessToken);
        const second = await sample(input.campaignId, accessToken);
        if (first.budgetMinor !== input.targetBudgetMinor || second.budgetMinor !== input.targetBudgetMinor ||
          first.unchanged !== before.unchanged || second.fingerprint !== first.fingerprint) unverified();
        return { outcome: "APPLIED_VERIFIED", observedBudgetMinor: second.budgetMinor };
      } catch { return { outcome: attempted ? "OUTCOME_UNKNOWN" : "NOT_SENT" }; }
    },
  };
}
