import { describe, expect, it, vi } from "vitest";
import { enrichLiveDiscoveryCampaign, type LiveDiscoveryIdentityGet } from "./liveDiscoveryIdentity.service";

const advertiserId = "9123456789012345678", campaignId = "9234567890123456789";
const shopId = "9345678901234567890", shopBc = "9456789012345678901", identityBc = "9567890123456789012";
const accountId = "9678901234567890123", foreignId = "9789012345678901234";
const campaign = {
  advertiser_id: advertiserId, campaign_id: campaignId, shopping_ads_type: "LIVE", operation_status: "ENABLE",
  store_id: "0", store_authorized_bc_id: "0",
};
const creator = { identity_id: "bc-id-creator", identity_type: "BC_AUTH_TT", identity_authorized_bc_id: identityBc, tiktok_account_id: accountId };
const shopIdentity = { identity_id: "shop-official-identity", identity_type: "TTS_TT", store_id: shopId };
const linkedShop = { ...campaign, store_id: shopId, store_authorized_bc_id: shopBc, identity_list: [shopIdentity] };
const store = { store_id: shopId, store_authorized_bc_id: shopBc, store_name: "ร้านจริง",
  store_authorized_bc_info: { bc_id: shopBc }, exclusive_authorized_advertiser_info: { advertiser_id: advertiserId } };
const unknown = { kind: "unknown", shopId: null, shopName: null, tiktokUsername: null };

function fixture(responses: Record<string, Record<string, unknown>>) {
  const get = vi.fn<Parameters<LiveDiscoveryIdentityGet>, ReturnType<LiveDiscoveryIdentityGet>>(async path => {
    if (!Object.hasOwn(responses, path)) throw new Error("unavailable");
    return responses[path];
  });
  return { get, read: () => enrichLiveDiscoveryCampaign({ advertiserId, campaignId, get }) };
}

describe("LIVE discovery display labels", () => {
  it("verifies the exact Creator handle through the identity lookup with the right BC", async () => {
    const h = fixture({ "/campaign/gmv_max/info/": { ...campaign, identity_list: [creator] },
      "/identity/info/": { identity_info: { ...creator, username: "creator_888", display_name: "Alias must not be used" } } });
    await expect(h.read()).resolves.toEqual({ ...unknown, kind: "creator", tiktokUsername: "creator_888" });
    expect(h.get.mock.calls).toEqual([
      ["/campaign/gmv_max/info/", { advertiser_id: advertiserId, campaign_id: campaignId }],
      ["/identity/info/", { advertiser_id: advertiserId, identity_id: creator.identity_id,
        identity_type: "BC_AUTH_TT", identity_authorized_bc_id: identityBc }],
    ]);
  });

  it.each([{ identity_id: "a-different-identity" }, { identity_type: "TT_USER" }, { advertiser_id: foreignId },
    { identity_authorized_bc_id: undefined }, { tiktok_account_id: foreignId }, { username: "@not-a-verified-handle" },
    { username: undefined }, { username: "0" }])("does not borrow or fabricate a Creator username: %j", async changes => {
    const h = fixture({ "/campaign/gmv_max/info/": { ...campaign, identity_list: [creator] },
      "/identity/info/": { identity_info: { ...creator, username: "not_ours", display_name: "not_the_handle", ...changes } } });
    await expect(h.read()).resolves.toEqual({ ...unknown, kind: "creator" });
  });

  it("reads TT_USER without inventing a Business Center", async () => {
    const identity = { identity_id: "tt-user-account", identity_type: "TT_USER" };
    const h = fixture({ "/campaign/gmv_max/info/": { ...campaign, identity_list: [identity] },
      "/identity/info/": { identity_info: { ...identity, username: "tt.account" } } });
    expect((await h.read()).tiktokUsername).toBe("tt.account");
    expect(h.get).toHaveBeenLastCalledWith("/identity/info/", { advertiser_id: advertiserId, identity_id: identity.identity_id, identity_type: "TT_USER" });
  });

  it("uses only an exact Shop ID and authorized BC and verifies the handle of a TTS_TT identity when returned", async () => {
    const h = fixture({ "/campaign/gmv_max/info/": linkedShop, "/gmv_max/store/list/": { store_list: [
      { ...store, store_id: foreignId }, { ...store, store_authorized_bc_id: foreignId }, { ...store, store_name: " ร้านจริง\u202e " },
    ] }, "/gmv_max/identity/get/": { identity_list: [
      { ...shopIdentity, identity_id: "other-id", user_name: "not_ours" }, { ...shopIdentity, user_name: "shop.real" },
    ] } });
    await expect(h.read()).resolves.toEqual({ kind: "shop", shopId, shopName: "ร้านจริง", tiktokUsername: "shop.real" });
    expect(h.get).toHaveBeenCalledWith("/gmv_max/store/list/", { advertiser_id: advertiserId });
    expect(h.get).toHaveBeenCalledWith("/gmv_max/identity/get/", { advertiser_id: advertiserId, store_id: shopId, store_authorized_bc_id: shopBc });
    expect(h.get.mock.calls.map(call => call[0])).not.toContain("/identity/info/");
  });

  it("retains the confirmed Shop and name if official Shop identity lacks a handle", async () => {
    const h = fixture({ "/campaign/gmv_max/info/": linkedShop, "/gmv_max/store/list/": { store_list: [store] },
      "/gmv_max/identity/get/": { identity_list: [{ ...shopIdentity, display_name: "looks_like_a_handle" }] } });
    await expect(h.read()).resolves.toEqual({ kind: "shop", shopId, shopName: "ร้านจริง", tiktokUsername: null });
  });

  it("reads a Shop campaign's BC_AUTH_TT handle from the campaign identity BC, not the Shop's BC", async () => {
    const identity = { ...creator, identity_authorized_shop_id: shopId };
    const h = fixture({ "/campaign/gmv_max/info/": { ...linkedShop, identity_list: [identity] },
      "/gmv_max/store/list/": { store_list: [store] }, "/identity/info/": { identity_info: { ...creator, username: "shop.creator" } } });
    await expect(h.read()).resolves.toEqual({ kind: "shop", shopId, shopName: "ร้านจริง", tiktokUsername: "shop.creator" });
    expect(h.get).toHaveBeenCalledWith("/identity/info/", { advertiser_id: advertiserId, identity_id: creator.identity_id,
      identity_type: "BC_AUTH_TT", identity_authorized_bc_id: identityBc });
  });

  it("does not trust a conflicting or ambiguous Shop label, even for the right ID", async () => {
    for (const store_list of [
      [{ ...store, store_authorized_bc_id: foreignId }],
      [{ ...store, exclusive_authorized_advertiser_info: { advertiser_id: foreignId } }],
      [{ ...store, store_authorized_bc_info: { bc_id: foreignId } }],
      [store, store],
    ]) {
      const h = fixture({ "/campaign/gmv_max/info/": linkedShop, "/gmv_max/store/list/": { store_list },
        "/gmv_max/identity/get/": { identity_list: [{ ...shopIdentity, store_id: foreignId, user_name: "wrong_shop" }] } });
      await expect(h.read()).resolves.toEqual({ kind: "shop", shopId, shopName: null, tiktokUsername: null });
    }
  });

  it("continues displaying a verified Shop badge if the label request is denied", async () => {
    const h = fixture({ "/campaign/gmv_max/info/": linkedShop });
    await expect(h.read()).resolves.toEqual({ ...unknown, kind: "shop", shopId });
  });

  it.each([{ advertiser_id: foreignId }, { campaign_id: foreignId }, { identity_list: [] },
    { identity_list: [{ ...creator, store_id: shopId }] }, { identity_list: [creator, creator] }])(
    "does not join an unverified advertiser, campaign or identity: %j", async changes => {
      const h = fixture({ "/campaign/gmv_max/info/": { ...campaign, identity_list: [creator], ...changes } });
      await expect(h.read()).resolves.toEqual(unknown);
      expect(h.get).toHaveBeenCalledTimes(1);
    },
  );

  it.each([{ operation_status: "DISABLE" }, { operation_status: "DELETE" }, { shopping_ads_type: "PRODUCT" }])(
    "drops a formerly ENABLE LIVE row only when exact current detail proves the change: %j", async changes => {
      const h = fixture({ "/campaign/gmv_max/info/": { ...campaign, ...changes } });
      await expect(h.read()).resolves.toEqual({ ...unknown, enabled: false });
      expect(h.get).toHaveBeenCalledTimes(1);
    },
  );
});
