import { describe, expect, it } from "vitest";
import { CREATOR_BINDING } from "./creatorRead.service";
import { createCreatorWebBudgetAdapters, createCreatorWebCapAdapters } from "./creatorWebBudget.adapters";
import { configuredCreatorAutoBudgetMode, configuredCreatorWebBudgetMode, creatorBudgetPolicyPath, type CreatorBudgetScope } from "./creatorBudgetScope";

const NOW = "2025-03-15T09:00:00.000Z", TODAY = "2025-03-15", CAMPAIGN = "1234567890123456";
const OP = "5035df00-1801-4d02-8051-01affbbefdc9", KEY = "p".repeat(43), TOKEN = "synthetic-tiktok-adapter-key";
const LEASE_END = "2025-03-15T09:00:55.000Z";
const policy = { schemaVersion: 1, clientId: "punpan_020", revision: 4, campaignCapMinor: 600_000,
  clientDailyCapMinor: 700_000, readAt: NOW, locked: false };
const SRIHIW = { clientId: "srihiw", advertiserId: "1234567890198765", tiktokAccountId: "1234567890198766",
  identityId: "synthetic-srihiw-identity", identityType: "BC_AUTH_TT" as const, identityAuthorizedBcId: "1234567890198767" };

function harness(options: { mode?: string; competing?: boolean; legacy?: boolean; policyKey?: string;
  providerResult?: "unknown" | "reject" | "roi-drift" | "reject-with-drift"; readAt?: string;
  extra?: boolean; extraLive?: boolean; extraClient?: "nnshop5719" | "ashopbytheta"; wrongProviderScope?: boolean } = {}) {
  const calls: { host: string; path: string; method: string }[] = [];
  const extra = options.extraClient ? { ...SRIHIW, clientId: options.extraClient,
    advertiserId: options.extraClient === "nnshop5719" ? "1234567890198768" : "1234567890198769",
    identityId: `synthetic-${options.extraClient}-identity` } : options.extra ? SRIHIW : undefined;
  const binding = extra ?? CREATOR_BINDING;
  let budget = 2800, roi = 15, stamp = "2025-03-15 08:55:00", spend = "2100.09", otherSpend = "20.00";
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({ host: url.host, path: url.pathname, method });
    expect(init?.redirect).toBe("error");
    if (url.host === "whale-buddy-ads-control-plane.onrender.com") {
      expect(headers.get("x-creator-web-key")).toBe(KEY);
      expect(headers.get("access-token")).toBeNull();
      expect(url.pathname).toContain(extra ? `/${extra.clientId}/policy` : "/ppan/policy");
      const reply = { ...policy, ...(extra ? { clientId: extra.clientId, configured: true } : {}), readAt: options.readAt ?? NOW };
      if (url.pathname.endsWith("/lease")) {
        expect(JSON.parse(String(init?.body))).toEqual({ operationId: OP, revision: 4 });
        return Response.json({ ...reply, locked: true, operationId: OP, expiresAt: LEASE_END });
      }
      if (url.pathname.endsWith("/finish")) {
        expect(JSON.parse(String(init?.body))).toEqual({ operationId: OP, outcome: "NOT_SENT" });
        return Response.json({ schemaVersion: 1, operationId: OP, outcome: "NOT_SENT", locked: false });
      }
      expect(method).toBe("GET");
      return Response.json(reply);
    }
    expect(url.host).toBe("business-api.tiktok.com");
    expect(headers.get("access-token")).toBe(TOKEN);
    expect(headers.get("x-creator-web-key")).toBeNull();
    if (method === "POST") {
      expect(url.pathname).toBe("/open_api/v1.3/campaign/gmv_max/update/");
      const body = JSON.parse(String(init?.body));
      expect(Object.keys(body).sort()).toEqual(["advertiser_id", "budget", "campaign_id"]);
      expect(body.advertiser_id).toBe(binding.advertiserId);
      expect(body.campaign_id).toBe(CAMPAIGN);
      if (options.providerResult === "unknown") throw new Error("synthetic socket close");
      if (options.providerResult === "reject") return Response.json({ code: 123 });
      budget = body.budget;
      stamp = "2025-03-15 09:00:00";
      if (options.providerResult === "roi-drift") roi++;
      if (options.providerResult === "reject-with-drift") return Response.json({ code: 123 });
      return Response.json({ code: 0, data: { campaign_id: CAMPAIGN } });
    }
    if (url.pathname.endsWith("/advertiser/info/")) return Response.json({ code: 0, data: { list: [{ advertiser_id: binding.advertiserId,
      timezone: "Asia/Bangkok", currency: "THB" }] } });
    expect(url.searchParams.get("advertiser_id")).toBe(binding.advertiserId);
    if (url.pathname.endsWith("/gmv_max/campaign/get/")) return Response.json({ code: 0, data: {
      page_info: { page: 1, total_page: 1, total_number: 1 }, list: [{ campaign_id: CAMPAIGN,
        advertiser_id: options.wrongProviderScope ? CREATOR_BINDING.advertiserId : binding.advertiserId, operation_status: "ENABLE", modify_time: stamp }] } });
    if (url.pathname.endsWith("/campaign/gmv_max/info/")) return Response.json({ code: 0, data: {
      advertiser_id: binding.advertiserId, campaign_id: CAMPAIGN, campaign_name: "Fixture LIVE", shopping_ads_type: "LIVE",
      store_id: "0", store_authorized_bc_id: "0", operation_status: "ENABLE", budget, roas_bid: roi,
      optimization_goal: "VALUE", deep_bid_type: "VO_MIN_ROAS", schedule_type: "SCHEDULE_FROM_NOW",
      schedule_start_time: "2025-03-15 08:30:00", auto_budget_enabled: options.competing === true,
      promotion_days: { is_enabled: false }, identity_list: [{ identity_id: binding.identityId,
        identity_type: binding.identityType, identity_authorized_bc_id: binding.identityAuthorizedBcId }] } });
    expect(url.pathname).toBe("/open_api/v1.3/report/integrated/get/");
    return Response.json({ code: 0, data: { page_info: { page: 1, total_page: 1, total_number: 2 }, list: [
      { dimensions: { campaign_id: CAMPAIGN, country_code: "TH", stat_time_day: TODAY }, metrics: { spend } },
      { dimensions: { campaign_id: "1234567890123457", country_code: "TH", stat_time_day: TODAY }, metrics: { spend: otherSpend } },
    ] } });
  }) as typeof fetch;
  const adapters = createCreatorWebBudgetAdapters({ loadToken: async () => TOKEN, fetchImpl, now: () => new Date(NOW), sleep: async () => {},
    extraBinding: extra,
    env: { CREATOR_READ_ENABLED: "true", CREATOR_WEB_BUDGET_MODE: options.mode ?? "live", CREATOR_WEB_BUDGET_LIVE_ENABLED: "true",
      CREATOR_WEB_SRIHIW_BUDGET_MODE: options.mode ?? "live", CREATOR_WEB_SRIHIW_BUDGET_LIVE_ENABLED: options.extraLive ? "true" : "false",
      ...(options.extraClient ? { [`CREATOR_WEB_${options.extraClient.toUpperCase()}_BUDGET_MODE`]: options.mode ?? "live",
        [`CREATOR_WEB_${options.extraClient.toUpperCase()}_BUDGET_LIVE_ENABLED`]: options.extraLive ? "true" : "false" } : {}),
      CREATOR_BUDGET_TEST_ENABLED: options.legacy ? "true" : "false", CREATOR_WEB_POLICY_BRIDGE_KEY: options.policyKey ?? KEY } });
  return { adapters, calls, edit(value: number) { budget = value; stamp = "2025-03-15 08:59:30"; }, setSpend(value: string) { spend = value; },
    setOtherSpend(value: string) { otherSpend = value; }, async input(targetBudgetMinor = 310_000) {
      const ctx = await adapters.readContext(CAMPAIGN);
      return { campaignId: CAMPAIGN, reportingDate: TODAY, expectedBudgetMinor: ctx.budgetMinor, targetBudgetMinor,
        fingerprint: ctx.fingerprint, notAfter: LEASE_END, campaignCapMinor: policy.campaignCapMinor, clientDailyCapMinor: policy.clientDailyCapMinor,
        nativeAutoOff: true as const, noConcurrentChanges: true as const, canSend: async () => true };
    }, providerPosts() { return calls.filter(c => c.host === "business-api.tiktok.com" && c.method === "POST"); } };
}

describe("Ppan web budget boundary", () => {
  it("reads fixed policy with a distinct key and validates lease/outcome envelopes", async () => {
    const { adapters } = harness();
    expect(await adapters.readPolicy()).toEqual({ revision: 4, campaignCapMinor: 600_000, clientDailyCapMinor: 700_000, readAt: NOW, locked: false });
    expect(await adapters.acquireLease(OP, 4)).toMatchObject({ locked: true, operationId: OP, expiresAt: LEASE_END });
    await expect(adapters.finishLease(OP, "NOT_SENT")).resolves.toBeUndefined();
    await expect(harness({ readAt: "2025-03-15T08:55:00.000Z" }).adapters.readPolicy()).rejects.toThrow("UNVERIFIED");
    const invalid = harness({ policyKey: "weak" });
    await expect(invalid.adapters.readPolicy()).rejects.toThrow("UNVERIFIED");
    expect(invalid.calls).toHaveLength(0);
  });

  it("uses an exact fresh scoped budget and returns success only after two matching readbacks", async () => {
    const h = harness();
    const input = await h.input();
    const before = h.calls.length;
    expect(await h.adapters.dispatch(input)).toEqual({ outcome: "APPLIED_VERIFIED", observedBudgetMinor: 310_000,
      observedFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(h.providerPosts()).toHaveLength(1);
    const after = h.calls.slice(before);
    expect(after.slice(after.findIndex(x => x.method === "POST") + 1).filter(x => x.path.endsWith("/info/"))).toHaveLength(2);
  });

  it("can safely request a decrease above spend", async () => {
    const h = harness();
    expect(await h.adapters.dispatch(await h.input(255_000))).toMatchObject({ outcome: "APPLIED_VERIFIED", observedBudgetMinor: 255_000 });
  });

  it.each(["disabled", "dry-run"])("does not dispatch in mode %s", async mode => {
    const h = harness({ mode });
    expect(await h.adapters.dispatch(await h.input())).toEqual({ outcome: "NOT_SENT" });
    expect(h.providerPosts()).toHaveLength(0);
  });

  it.each(["native", "legacy", "manual edit", "spent through target", "client cap", "expires", "revoked operator"])("blocks %s before write", async scenario => {
    const h = harness({ competing: scenario === "native", legacy: scenario === "legacy" });
    const input = await h.input();
    if (scenario === "manual edit") h.edit(2900);
    if (scenario === "spent through target") h.setSpend("3100.00");
    if (scenario === "client cap") h.setOtherSpend("4000.00");
    if (scenario === "expires") input.notAfter = "2025-03-15T09:00:02.000Z";
    if (scenario === "revoked operator") input.canSend = async () => false;
    expect(await h.adapters.dispatch(input)).toEqual({ outcome: "NOT_SENT" });
    expect(h.providerPosts()).toHaveLength(0);
  });

  it.each(["unknown", "roi-drift", "reject-with-drift", "reject"] as const)("never resends a provider result: %s", async providerResult => {
    const h = harness({ providerResult });
    expect(await h.adapters.dispatch(await h.input())).toEqual({ outcome: "OUTCOME_UNKNOWN" });
    expect(h.providerPosts()).toHaveLength(1);
  });
});

describe("Srihiw exact budget writer boundary", () => {
  it("uses the separately verified scope, policy lease and budget-only provider mutation", async () => {
    const h = harness({ extra: true, extraLive: true });
    expect(await h.adapters.acquireLease(OP, 4)).toMatchObject({ locked: true, operationId: OP });
    expect(await h.adapters.dispatch(await h.input())).toMatchObject({ outcome: "APPLIED_VERIFIED", observedBudgetMinor: 310_000 });
    expect(h.providerPosts()).toHaveLength(1);
  });
  it("keeps a Ppan live flag from enabling Srihiw and fails closed on a foreign row", async () => {
    const disabled = harness({ extra: true });
    expect(await disabled.adapters.dispatch(await disabled.input())).toEqual({ outcome: "NOT_SENT" });
    expect(disabled.providerPosts()).toHaveLength(0);
    const cross = harness({ extra: true, extraLive: true, wrongProviderScope: true });
    await expect(cross.input()).rejects.toThrow();
    expect(cross.providerPosts()).toHaveLength(0);
  });
});

describe("additional exact live budget scopes", () => {
  it.each(["nnshop5719", "ashopbytheta"] as const)("%s uses its own lease, exact advertiser token and a single budget-only send", async extraClient => {
    const blocked = harness({ extraClient });
    expect(await blocked.adapters.dispatch(await blocked.input())).toEqual({ outcome: "NOT_SENT" });
    expect(blocked.providerPosts()).toHaveLength(0);
    const h = harness({ extraClient, extraLive: true });
    expect(await h.adapters.acquireLease(OP, 4)).toMatchObject({ locked: true, operationId: OP });
    expect(await h.adapters.dispatch(await h.input())).toMatchObject({ outcome: "APPLIED_VERIFIED", observedBudgetMinor: 310_000 });
    expect(h.providerPosts()).toHaveLength(1);
    const wrong = harness({ extraClient, extraLive: true, wrongProviderScope: true });
    await expect(wrong.input()).rejects.toThrow();
    expect(wrong.providerPosts()).toHaveLength(0);
  });

  it("keeps global and neighboring flags from granting unconfigured or other advertiser access", () => {
    const env = { CREATOR_READ_ENABLED: "true", CREATOR_WEB_BUDGET_MODE: "live", CREATOR_WEB_BUDGET_LIVE_ENABLED: "true",
      CREATOR_AUTO_BUDGET_MODE: "live", CREATOR_AUTO_BUDGET_LIVE_ENABLED: "true",
      CREATOR_WEB_NNSHOP5719_BUDGET_MODE: "live", CREATOR_WEB_NNSHOP5719_BUDGET_LIVE_ENABLED: "true",
      CREATOR_AUTO_BUDGET_NNSHOP5719_MODE: "live", CREATOR_AUTO_BUDGET_NNSHOP5719_LIVE_ENABLED: "true",
      CREATOR_AUTO_BUDGET_ASHOPBYTHETA_MODE: "live", CREATOR_AUTO_BUDGET_ASHOPBYTHETA_LIVE_ENABLED: "true" };
    expect(configuredCreatorAutoBudgetMode(env, "nnshop5719")).toBe("live");
    expect(configuredCreatorAutoBudgetMode(env, "ashopbytheta")).toBe("disabled");
    expect(configuredCreatorWebBudgetMode(env, "shop-other" as CreatorBudgetScope)).toBe("disabled");
    expect(creatorBudgetPolicyPath("constructor" as CreatorBudgetScope)).toBeNull();
  });
});

describe("Web-only cap policy bridge", () => {
  const initial = { schemaVersion: 1, clientId: "srihiw", configured: false, readAt: NOW, locked: false, capWriteEnabled: true };
  const set = { ...initial, configured: true, revision: 1, campaignCapMinor: 500000, clientDailyCapMinor: 500000 };
  function setup(responses: Response[]) {
    const calls: { path: string; method?: string; body?: unknown }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("whale-buddy-ads-control-plane.onrender.com");
      expect(new Headers(init?.headers).get("x-creator-web-key")).toBe(KEY);
      expect(new Headers(init?.headers).get("access-token")).toBeNull();
      calls.push({ path: url.pathname, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const response = responses.shift();
      if (!response) throw new Error("socket closed");
      return response;
    }) as typeof fetch;
    return { calls, api: createCreatorWebCapAdapters({ fetchImpl, now: () => new Date(NOW), env: { CREATOR_WEB_POLICY_BRIDGE_KEY: KEY } }) };
  }
  it("only initializes Srihiw's missing cap with revision zero and the authenticated actor", async () => {
    const h = setup([Response.json(initial), Response.json(initial), Response.json(set)]);
    expect(await h.api.status("srihiw")).toEqual({ cap: null, capEditAllowed: true });
    await expect(h.api.update("srihiw", 22, 0, 500000, async () => true)).resolves.toEqual({ capMinor: 500000, revision: 1 });
    expect(h.calls.map(x => [x.method, x.path])).toEqual([["GET", "/internal/automation/srihiw/policy"],
      ["GET", "/internal/automation/srihiw/policy"], ["POST", "/internal/automation/srihiw/policy/cap"]]);
    expect(h.calls[2].body).toEqual({ revision: 0, capMinor: 500000, actorUserId: 22 });
  });
  it("does not send on stale, locked, revoked, or wrong-scope cap read", async () => {
    for (const [raw, code, role] of [[set, "CAP_CHANGED", true], [{ ...set, locked: true }, "CAP_LOCKED", true],
      [initial, "BUDGET_OPERATOR_DENIED", false], [{ ...initial, clientId: "punpan_020" }, "CAP_UPDATE_UNCONFIRMED", true]] as const) {
      const h = setup([Response.json(raw)]);
      await expect(h.api.update("srihiw", 22, "locked" in raw && raw.locked ? 1 : 0, 555000, async () => role)).rejects.toMatchObject({ code });
      expect(h.calls.map(c => c.method)).toEqual(["GET"]);
    }
  });
  it("uses the same policy compare-and-set and treats an unknown send outcome as refresh-only", async () => {
    const current = { ...policy, capWriteEnabled: true, clientDailyCapMinor: policy.campaignCapMinor };
    const changed = setup([Response.json(current), Response.json({ error: { code: "POLICY_CHANGED" } }, { status: 409 })]);
    await expect(changed.api.update("punpan_020", 22, 4, 550000, async () => true)).rejects.toMatchObject({ code: "CAP_CHANGED", httpStatus: 409 });
    expect(changed.calls.at(-1)?.path).toBe("/internal/automation/ppan/policy/cap");
    const unknown = setup([Response.json(current)]);
    await expect(unknown.api.update("punpan_020", 22, 4, 550000, async () => true)).rejects.toMatchObject({ code: "CAP_UPDATE_UNCONFIRMED" });
    expect(unknown.calls.filter(c => c.method === "POST")).toHaveLength(1);
  });
});
