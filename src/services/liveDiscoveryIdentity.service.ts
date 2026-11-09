import { verifiedTikTokUsername } from "./creatorIdentityUsername.service";

type Data = Record<string, unknown>;
export type LiveDiscoveryIdentityGet = (path: string, query: Record<string, string | number | object>) => Promise<Data>;
export type LiveDiscoveryIdentity = {
  kind: "creator" | "shop" | "unknown";
  tiktokUsername: string | null;
  shopId: string | null;
  shopName: string | null;
  /** Only set when a newer exact detail positively proves the list row should be dropped. */
  enabled?: false;
};

const INFO = "/campaign/gmv_max/info/";
const IDENTITY = "/identity/info/";
const STORES = "/gmv_max/store/list/";
const SHOP_IDENTITIES = "/gmv_max/identity/get/";
const resourceId = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{5,30}$/.test(value);
const identityId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{6,128}$/.test(value) && !/^0+$/.test(value);
const isRecord = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value);
const noResource = (value: unknown) => value == null || value === "" || value === "0";
const username = (value: unknown) => value === "0" ? null : verifiedTikTokUsername(value);
const EMPTY: Readonly<LiveDiscoveryIdentity> = Object.freeze({ kind: "unknown", tiktokUsername: null, shopId: null, shopName: null });
const ordinaryIdentityTypes = new Set(["BC_AUTH_TT", "TT_USER", "AUTH_CODE"]);

function matchesIfPresent(value: unknown, expected: string): boolean {
  return value === undefined || value === expected;
}

function matchesShopIfPresent(value: unknown, shopId: string): boolean {
  return noResource(value) || value === shopId;
}

function exactIdentity(value: Data, wanted: Data, advertiserId: string): boolean {
  if (value.identity_id !== wanted.identity_id || value.identity_type !== wanted.identity_type ||
      !matchesIfPresent(value.advertiser_id, advertiserId)) return false;
  if (wanted.identity_type === "BC_AUTH_TT" &&
      (!resourceId(wanted.identity_authorized_bc_id) || value.identity_authorized_bc_id !== wanted.identity_authorized_bc_id)) return false;
  // Older provider payloads omit this field. When both endpoints report it they
  // must agree; it never replaces the exact identity + authorized BC join.
  return value.tiktok_account_id === undefined ||
    (resourceId(value.tiktok_account_id) && matchesIfPresent(wanted.tiktok_account_id, value.tiktok_account_id));
}

function displayStoreName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  return name.length > 0 && name.length <= 160 ? name : null;
}

async function readOrdinaryUsername(get: LiveDiscoveryIdentityGet, advertiserId: string, wanted: Data): Promise<string | null> {
  const id = wanted.identity_id, type = wanted.identity_type, bc = wanted.identity_authorized_bc_id;
  if (!identityId(id) || typeof type !== "string" || !ordinaryIdentityTypes.has(type) ||
      (type === "BC_AUTH_TT" && !resourceId(bc))) return null;
  const data = await get(IDENTITY, { advertiser_id: advertiserId, identity_id: id, identity_type: type,
    ...(type === "BC_AUTH_TT" && resourceId(bc) ? { identity_authorized_bc_id: bc } : {}) });
  return isRecord(data) && matchesIfPresent(data.advertiser_id, advertiserId) && isRecord(data.identity_info) &&
    exactIdentity(data.identity_info, wanted, advertiserId) ? username(data.identity_info.username) : null;
}

async function readStoreName(get: LiveDiscoveryIdentityGet, advertiserId: string, shopId: string, bcId: string): Promise<string | null> {
  const data = await get(STORES, { advertiser_id: advertiserId });
  if (!isRecord(data) || !matchesIfPresent(data.advertiser_id, advertiserId) || !Array.isArray(data.store_list) || data.store_list.length > 500) return null;
  const exact = data.store_list.filter(row => isRecord(row) && row.store_id === shopId && row.store_authorized_bc_id === bcId);
  if (exact.length !== 1) return null;
  const row = exact[0] as Data;
  const exclusive = row.exclusive_authorized_advertiser_info, authorizedBc = row.store_authorized_bc_info;
  if (!matchesIfPresent(row.advertiser_id, advertiserId) ||
      (exclusive != null && (!isRecord(exclusive) || !(noResource(exclusive.advertiser_id) || exclusive.advertiser_id === advertiserId))) ||
      (authorizedBc != null && (!isRecord(authorizedBc) || !matchesIfPresent(authorizedBc.bc_id, bcId)))) return null;
  return displayStoreName(row.store_name);
}

async function readShopUsername(get: LiveDiscoveryIdentityGet, advertiserId: string, shopId: string,
  bcId: string, wanted: Data): Promise<string | null> {
  if (!identityId(wanted.identity_id) || wanted.identity_type !== "TTS_TT" ||
      !matchesShopIfPresent(wanted.store_id, shopId)) return null;
  const data = await get(SHOP_IDENTITIES, { advertiser_id: advertiserId, store_id: shopId, store_authorized_bc_id: bcId });
  if (!isRecord(data) || !matchesIfPresent(data.advertiser_id, advertiserId) ||
      !matchesIfPresent(data.store_id, shopId) || !matchesIfPresent(data.store_authorized_bc_id, bcId) ||
      !Array.isArray(data.identity_list) || data.identity_list.length > 500) return null;
  const exact = data.identity_list.filter(row => isRecord(row) && row.identity_id === wanted.identity_id && row.identity_type === wanted.identity_type);
  if (exact.length !== 1) return null;
  const row = exact[0] as Data;
  // TTS_TT is not supported by /identity/info/. The Shop-scoped identity
  // API sometimes omits user_name for this identity; display_name isn't a handle.
  return exactIdentity(row, wanted, advertiserId) && matchesShopIfPresent(row.store_id, shopId) &&
    matchesShopIfPresent(row.identity_authorized_shop_id, shopId) ? username(row.user_name) : null;
}

/** Read-only discovery labels. Never suitable as authority for campaign control. */
export async function enrichLiveDiscoveryCampaign({ advertiserId, campaignId, get }: {
  advertiserId: string;
  campaignId: string;
  get: LiveDiscoveryIdentityGet;
}): Promise<LiveDiscoveryIdentity> {
  if (!resourceId(advertiserId) || !resourceId(campaignId)) return EMPTY;
  const info = await get(INFO, { advertiser_id: advertiserId, campaign_id: campaignId }).catch(() => null);
  if (!isRecord(info) || info.advertiser_id !== advertiserId || info.campaign_id !== campaignId) return EMPTY;
  if (info.shopping_ads_type === "PRODUCT" || info.operation_status === "DISABLE" || info.operation_status === "DELETE") return { ...EMPTY, enabled: false };
  if (info.shopping_ads_type !== "LIVE" || info.operation_status !== "ENABLE") return EMPTY;
  const candidate = Array.isArray(info.identity_list) && info.identity_list.length === 1 ? info.identity_list[0] : null;
  const identity = isRecord(candidate) && matchesIfPresent(candidate.advertiser_id, advertiserId) ? candidate : null;
  const shopId = info.store_id, bcId = info.store_authorized_bc_id;

  if (resourceId(shopId)) {
    const verifiedShop = { kind: "shop" as const, shopId, tiktokUsername: null, shopName: null };
    if (!resourceId(bcId)) return verifiedShop;
    const nameRead = readStoreName(get, advertiserId, shopId, bcId).catch(() => null);
    const handleRead = identity && matchesShopIfPresent(identity.store_id, shopId) &&
      matchesShopIfPresent(identity.identity_authorized_shop_id, shopId) ?
      (identity.identity_type === "TTS_TT"
        ? readShopUsername(get, advertiserId, shopId, bcId, identity)
        : readOrdinaryUsername(get, advertiserId, identity)).catch(() => null) : null;
    const [shopName, tiktokUsername] = await Promise.all([nameRead, handleRead]);
    return { ...verifiedShop, shopName, tiktokUsername };
  }
  if (!noResource(shopId) || !noResource(bcId) || !identity ||
      !noResource(identity.store_id) || !noResource(identity.identity_authorized_shop_id) ||
      typeof identity.identity_type !== "string" || !ordinaryIdentityTypes.has(identity.identity_type) ||
      !identityId(identity.identity_id) || (identity.identity_type === "BC_AUTH_TT" && !resourceId(identity.identity_authorized_bc_id))) return EMPTY;
  return { ...EMPTY, kind: "creator", tiktokUsername: await readOrdinaryUsername(get, advertiserId, identity).catch(() => null) };
}
