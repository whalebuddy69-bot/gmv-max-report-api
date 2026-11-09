import { verifiedTikTokUsername } from "./creatorIdentityUsername.service";
import { CREATOR_BINDING } from "./creatorRead.service";

const BASE = "https://business-api.tiktok.com/open_api/v1.3";
const TIMEOUT_MS = 12_000;
const MAX_BODY_BYTES = 256 * 1024;
const RESOURCE_ID = /^[1-9]\d{5,30}$/;
const IDENTITY_ID = /^[A-Za-z0-9_-]{6,100}$/;
const BC = CREATOR_BINDING.identityAuthorizedBcId;
const IDENTITY_TYPE = "BC_AUTH_TT";

type Row = Record<string, unknown>;
type ReadPath = "/advertiser/info/" | "/campaign/gmv_max/info/" | "/identity/info/";

export type CreatorMonitorCandidate = Readonly<{ advertiserId: string; campaignId: string; expectedUsername: string }>;
export type CreatorMonitorProof = Readonly<{
  advertiserId: string;
  campaignId: string;
  tiktokUsername: string;
  tiktokAccountId: string | null;
  identityId: string;
  identityType: typeof IDENTITY_TYPE;
  identityAuthorizedBcId: string;
}>;

export class CreatorMonitorProofError extends Error {
  readonly code = "CREATOR_MONITOR_PROOF_UNVERIFIED";
  constructor() { super("CREATOR_MONITOR_PROOF_UNVERIFIED"); this.name = "CreatorMonitorProofError"; }
}

const fail = (): never => { throw new CreatorMonitorProofError(); };
const record = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === "string" && RESOURCE_ID.test(value);
const noShop = (value: unknown) => value == null || value === "" || value === "0";
const matchesIfPresent = (value: unknown, expected: string) => value === undefined || value === expected;

async function providerData(response: Response): Promise<Row> {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_BODY_BYTES) return fail();
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return fail();
      }
      chunks.push(Buffer.from(chunk.value));
    }
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!record(payload) || payload.code !== 0 || !record(payload.data)) return fail();
    return payload.data;
  } finally { reader.releaseLock(); }
}

/** Re-prove a discovery selection using only exact, fresh TikTok reads; this never grants edit or Auto privileges. */
export function createCreatorMonitorProof({ loadToken, fetchImpl = fetch }: {
  loadToken: (advertiserId: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}): (candidate: CreatorMonitorCandidate) => Promise<CreatorMonitorProof> {
  return async candidate => {
    if (!record(candidate)) return fail();
    const { advertiserId, campaignId, expectedUsername } = candidate;
    if (!validId(advertiserId) || !validId(campaignId) || !verifiedTikTokUsername(expectedUsername)) return fail();

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new CreatorMonitorProofError()); }, TIMEOUT_MS);
    });
    async function verify(): Promise<CreatorMonitorProof> {
      const token = await loadToken(advertiserId);
      if (controller.signal.aborted || typeof token !== "string" || !/^[^\x00-\x20\x7f]{16,4096}$/.test(token)) return fail();
      const resemblesToken = (value: string) => value.length >= 16 && token.includes(value);
      async function get(path: ReadPath, query: Record<string, string | readonly string[]>): Promise<Row> {
        if (controller.signal.aborted) return fail();
        const url = new URL(BASE + path);
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
        const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: controller.signal,
          headers: { "Access-Token": token, Accept: "application/json", "Cache-Control": "no-cache" } });
        return providerData(response);
      }

      const info = await get("/campaign/gmv_max/info/", { advertiser_id: advertiserId, campaign_id: campaignId });
      const identities = info.identity_list;
      if (info.advertiser_id !== advertiserId || info.campaign_id !== campaignId ||
          info.operation_status !== "ENABLE" || info.shopping_ads_type !== "LIVE" ||
          !noShop(info.store_id) || !noShop(info.store_authorized_bc_id) || !Array.isArray(identities) || identities.length !== 1) return fail();
      const campaignIdentity: unknown = identities[0];
      if (!record(campaignIdentity) || !matchesIfPresent(campaignIdentity.advertiser_id, advertiserId) ||
          campaignIdentity.identity_type !== IDENTITY_TYPE || campaignIdentity.identity_authorized_bc_id !== BC ||
          !noShop(campaignIdentity.store_id) || !noShop(campaignIdentity.identity_authorized_shop_id)) return fail();
      const identityId = campaignIdentity.identity_id;
      if (typeof identityId !== "string" || !IDENTITY_ID.test(identityId) || /^0+$/.test(identityId) || resemblesToken(identityId)) return fail();

      const identityData = await get("/identity/info/", { advertiser_id: advertiserId, identity_id: identityId,
        identity_type: IDENTITY_TYPE, identity_authorized_bc_id: BC });
      const identity = identityData.identity_info;
      if (!record(identity) || !matchesIfPresent(identityData.advertiser_id, advertiserId) || !matchesIfPresent(identity.advertiser_id, advertiserId) ||
          identity.identity_id !== identityId || identity.identity_type !== IDENTITY_TYPE || identity.identity_authorized_bc_id !== BC ||
          (identity.can_use_live_ads !== undefined && identity.can_use_live_ads !== true) ||
          (identity.available_status !== undefined && identity.available_status !== "AVAILABLE") ||
          !noShop(identity.store_id) || !noShop(identity.identity_authorized_shop_id) ||
          identity.username !== expectedUsername || resemblesToken(expectedUsername)) return fail();

      const numericFields = [info.tiktok_account_id, campaignIdentity.tiktok_account_id, identity.tiktok_account_id];
      const presentIds = numericFields.filter(value => value != null);
      if (presentIds.some(value => !validId(value) || resemblesToken(value)) || new Set(presentIds).size > 1) return fail();
      // A UUID, ad account ID, nickname or browser-supplied value is not a TikTok
      // account ID. Even a single explicit upstream field is not a cross-check.
      const tiktokAccountId = validId(identity.tiktok_account_id) &&
        (campaignIdentity.tiktok_account_id === identity.tiktok_account_id || info.tiktok_account_id === identity.tiktok_account_id)
        ? identity.tiktok_account_id : null;

      const advertiserData = await get("/advertiser/info/", { advertiser_ids: [advertiserId], fields: ["advertiser_id", "currency", "timezone"] });
      const accounts = advertiserData.list;
      if (!matchesIfPresent(advertiserData.advertiser_id, advertiserId) || !Array.isArray(accounts) || accounts.length !== 1 ||
          !record(accounts[0]) || accounts[0].advertiser_id !== advertiserId ||
          accounts[0].currency !== "THB" || accounts[0].timezone !== "Asia/Bangkok" || controller.signal.aborted) return fail();

      return Object.freeze({ advertiserId, campaignId, tiktokUsername: expectedUsername, tiktokAccountId,
        identityId, identityType: IDENTITY_TYPE, identityAuthorizedBcId: BC });
    }

    try { return await Promise.race([verify(), timedOut]); }
    catch { return fail(); } // Do not leak provider messages, response bodies, or credentials.
    finally { clearTimeout(timer); }
  };
}
