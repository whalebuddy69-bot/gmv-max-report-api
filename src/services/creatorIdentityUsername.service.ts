import type { CreatorReadBinding, CreatorReadDependencies } from "./creatorRead.service";

const endpoint = "https://business-api.tiktok.com/open_api/v1.3/identity/info/";
const successTtlMs = 5 * 60_000, failureTtlMs = 30_000, maxBytes = 256 * 1024;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function verifiedTikTokUsername(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._]{1,24}$/.test(value) && !value.endsWith(".") ? value : null;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maxBytes) return null;
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) { void reader.cancel().catch(() => undefined); return null; }
      chunks.push(Buffer.from(chunk.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}

/** Dashboard-only metadata. Never used as a campaign, token, or write scope. */
export function createCreatorIdentityUsernameReader({ loadToken, fetchImpl = fetch, now = () => new Date() }: CreatorReadDependencies,
  configured: CreatorReadBinding) {
  const binding = Object.freeze({ ...configured });
  let cache: { checkedAt: number; username: string | null } | undefined;
  let inFlight: Promise<string | null> | undefined;

  async function read(): Promise<string | null> {
    if (binding.identityType !== "BC_AUTH_TT") return null;
    const token = await loadToken();
    if (typeof token !== "string" || !/^[^\x00-\x20\x7f]{16,4096}$/.test(token)) return null;
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries({ advertiser_id: binding.advertiserId, identity_id: binding.identityId,
      identity_type: binding.identityType, identity_authorized_bc_id: binding.identityAuthorizedBcId })) url.searchParams.set(key, value);
    const payload = await boundedJson(await fetchImpl(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(4_000),
      headers: { "Access-Token": token, Accept: "application/json" } }));
    if (!record(payload) || payload.code !== 0 || !record(payload.data) || !record(payload.data.identity_info)) return null;
    const data = payload.data, identity = payload.data.identity_info;
    if (identity.identity_id !== binding.identityId || identity.identity_type !== binding.identityType ||
      identity.identity_authorized_bc_id !== binding.identityAuthorizedBcId ||
      (identity.tiktok_account_id !== undefined && identity.tiktok_account_id !== binding.tiktokAccountId) ||
      (identity.advertiser_id !== undefined && identity.advertiser_id !== binding.advertiserId) ||
      (data.advertiser_id !== undefined && data.advertiser_id !== binding.advertiserId)) return null;
    const username = verifiedTikTokUsername(identity.username);
    return username !== null && !(username.length >= 16 && token.includes(username)) ? username : null;
  }

  return async function username() {
    const at = now().getTime();
    if (cache && at >= cache.checkedAt && at - cache.checkedAt < (cache.username === null ? failureTtlMs : successTtlMs)) return cache.username;
    if (!inFlight) inFlight = read().catch(() => null).then(username => {
      cache = { checkedAt: now().getTime(), username };
      return username;
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
