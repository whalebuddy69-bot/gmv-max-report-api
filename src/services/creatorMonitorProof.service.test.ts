import { describe, expect, it, vi } from "vitest";
import { CREATOR_BINDING } from "./creatorRead.service";
import { createCreatorMonitorProof, CreatorMonitorProofError } from "./creatorMonitorProof.service";

const BC = CREATOR_BINDING.identityAuthorizedBcId;
const AD = "9123456789012345678";
const CAMPAIGN = "9123456789012345679";
const IDENTITY = "11111111-abcd-5678-1234-987654321abc";
const ACCOUNT = "9123456789012345680";
const DIFFERENT = "9123456789012345681";
const USERNAME = "example.creator";
const CANDIDATE = { advertiserId: AD, campaignId: CAMPAIGN, expectedUsername: USERNAME };
const TOKEN = "local-test-provider-credential";
const ADVERTISER_PATH = "/open_api/v1.3/advertiser/info/";
const CAMPAIGN_PATH = "/open_api/v1.3/campaign/gmv_max/info/";
const IDENTITY_PATH = "/open_api/v1.3/identity/info/";
const CAMPAIGN_IDENTITY = { identity_id: IDENTITY, identity_type: "BC_AUTH_TT", identity_authorized_bc_id: BC };

function setup(patches: { campaign?: Record<string, unknown>; campaignIdentity?: Record<string, unknown>;
  identity?: Record<string, unknown>; identityOuter?: Record<string, unknown>; advertiser?: Record<string, unknown>;
  response?: (path: string) => Response | undefined; loadToken?: () => Promise<string> } = {}) {
  const fetchImpl = vi.fn(async (url: URL, request: RequestInit) => {
    const headers = new Headers(request.headers);
    expect(url.origin).toBe("https://business-api.tiktok.com");
    expect(request.method).toBe("GET");
    expect(request.redirect).toBe("error");
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(headers.get("Access-Token")).toBe(TOKEN);
    expect(headers.get("Cache-Control")).toBe("no-cache");
    const forced = patches.response?.(url.pathname);
    if (forced) return forced;
    if (url.pathname === CAMPAIGN_PATH) {
      expect(Object.fromEntries(url.searchParams)).toEqual({ advertiser_id: AD, campaign_id: CAMPAIGN });
      return Response.json({ code: 0, data: { advertiser_id: AD, campaign_id: CAMPAIGN, operation_status: "ENABLE",
        shopping_ads_type: "LIVE", store_id: "0", store_authorized_bc_id: "0",
        identity_list: [{ ...CAMPAIGN_IDENTITY, ...patches.campaignIdentity }], ...patches.campaign } });
    }
    if (url.pathname === IDENTITY_PATH) {
      expect(Object.fromEntries(url.searchParams)).toEqual({ advertiser_id: AD, identity_id: IDENTITY,
        identity_type: "BC_AUTH_TT", identity_authorized_bc_id: BC });
      return Response.json({ code: 0, data: { identity_info: { ...CAMPAIGN_IDENTITY, username: USERNAME,
        display_name: "A display name is not a handle", available_status: "AVAILABLE", ...patches.identity }, ...patches.identityOuter } });
    }
    expect(url.pathname).toBe(ADVERTISER_PATH);
    expect(Object.fromEntries(url.searchParams)).toEqual({ advertiser_ids: JSON.stringify([AD]),
      fields: JSON.stringify(["advertiser_id", "currency", "timezone"]) });
    return Response.json({ code: 0, data: { list: [{ advertiser_id: AD, currency: "THB", timezone: "Asia/Bangkok" }], ...patches.advertiser } });
  });
  const loadToken = vi.fn(patches.loadToken ?? (async () => TOKEN));
  return { fetchImpl, loadToken, prove: createCreatorMonitorProof({ loadToken, fetchImpl: fetchImpl as unknown as typeof fetch }) };
}

describe("mobile Creator monitoring proof", () => {
  it("proves only the exact advertiser and LIVE identity, with no numeric ID inferred from the UUID", async () => {
    const h = setup();
    await expect(h.prove(CANDIDATE)).resolves.toEqual({ advertiserId: AD, campaignId: CAMPAIGN, tiktokUsername: USERNAME,
      tiktokAccountId: null, identityId: IDENTITY, identityType: "BC_AUTH_TT", identityAuthorizedBcId: BC });
    expect(h.loadToken).toHaveBeenCalledTimes(1);
    expect(h.loadToken).toHaveBeenCalledWith(AD);
    expect(h.fetchImpl.mock.calls.map(([url]) => url.pathname)).toEqual([CAMPAIGN_PATH, IDENTITY_PATH, ADVERTISER_PATH]);
  });

  it("returns a numeric ID only when the campaign detail and exact identity responses agree", async () => {
    await expect(setup({ campaignIdentity: { tiktok_account_id: ACCOUNT }, identity: { tiktok_account_id: ACCOUNT, can_use_live_ads: true } })
      .prove(CANDIDATE)).resolves.toMatchObject({ tiktokAccountId: ACCOUNT });
    await expect(setup({ identity: { tiktok_account_id: ACCOUNT } }).prove(CANDIDATE)).resolves.toMatchObject({ tiktokAccountId: null });
    await expect(setup({ campaignIdentity: { tiktok_account_id: ACCOUNT }, identity: { tiktok_account_id: DIFFERENT } })
      .prove(CANDIDATE)).rejects.toBeInstanceOf(CreatorMonitorProofError);
  });

  it.each([{ advertiser_id: DIFFERENT }, { campaign_id: DIFFERENT }, { shopping_ads_type: "PRODUCT" }, { operation_status: "DISABLE" },
    { store_id: DIFFERENT }, { store_authorized_bc_id: DIFFERENT }, { identity_list: [CAMPAIGN_IDENTITY, CAMPAIGN_IDENTITY] },
    { identity_list: [] }])("does not proceed to identity lookup for a mismatched campaign: %j", async campaign => {
    const h = setup({ campaign });
    await expect(h.prove(CANDIDATE)).rejects.toBeInstanceOf(CreatorMonitorProofError);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([{ identity_type: "TT_USER" }, { identity_authorized_bc_id: DIFFERENT }, { advertiser_id: DIFFERENT },
    { identity_authorized_shop_id: DIFFERENT }, { identity_id: "00000000000" }])("rejects an unscoped campaign identity: %j", async campaignIdentity => {
    const h = setup({ campaignIdentity });
    await expect(h.prove(CANDIDATE)).rejects.toBeInstanceOf(CreatorMonitorProofError);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([{ identity_id: "another-provider-identity" }, { identity_authorized_bc_id: DIFFERENT }, { advertiser_id: DIFFERENT },
    { username: "somebody.else" }, { username: USERNAME.toUpperCase() }, { username: undefined, display_name: USERNAME },
    { identity_type: "TT_USER" }, { available_status: "SCOPE_UNAVAILABLE" }, { can_use_live_ads: false }])("rejects mismatched or unauthorized identity details: %j", async identity => {
    const h = setup({ identity });
    await expect(h.prove(CANDIDATE)).rejects.toBeInstanceOf(CreatorMonitorProofError);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects an advertiser mismatch in the identity response envelope", async () => {
    await expect(setup({ identityOuter: { advertiser_id: DIFFERENT } }).prove(CANDIDATE)).rejects.toBeInstanceOf(CreatorMonitorProofError);
  });

  it.each([[], [{ advertiser_id: DIFFERENT, currency: "THB", timezone: "Asia/Bangkok" }],
    [{ advertiser_id: AD, currency: "USD", timezone: "Asia/Bangkok" }], [{ advertiser_id: AD, currency: "THB", timezone: "UTC" }],
    [null, null]])("fails closed for incomplete or mismatched advertiser metadata: %j", async (...list) => {
    const h = setup({ advertiser: { list } });
    await expect(h.prove(CANDIDATE)).rejects.toBeInstanceOf(CreatorMonitorProofError);
    expect(h.fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("validates browser candidates before any credential or provider operation", async () => {
    const h = setup();
    await expect(h.prove({ ...CANDIDATE, advertiserId: "https://example.invalid" })).rejects.toBeInstanceOf(CreatorMonitorProofError);
    await expect(h.prove({ ...CANDIDATE, expectedUsername: "@example.creator" })).rejects.toBeInstanceOf(CreatorMonitorProofError);
    expect(h.loadToken).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds response size and does not relay provider denials", async () => {
    for (const bad of [new Response("x".repeat(256 * 1024 + 1)), Response.json({ code: 40001, message: TOKEN })]) {
      const h = setup({ response: () => bad });
      await expect(h.prove(CANDIDATE)).rejects.toMatchObject({ message: "CREATOR_MONITOR_PROOF_UNVERIFIED" });
      expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("bounds the overall proof and never issues a GET after a timed-out token load", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (token: string) => void;
      const h = setup({ loadToken: () => new Promise(resolve => { finish = resolve; }) });
      const proof = h.prove(CANDIDATE);
      const checked = expect(proof).rejects.toBeInstanceOf(CreatorMonitorProofError);
      await vi.advanceTimersByTimeAsync(12_000);
      await checked;
      finish(TOKEN);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.fetchImpl).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
