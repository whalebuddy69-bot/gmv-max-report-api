import { config } from "../config";
import { decryptSecretBatch } from "../utils/crypto";
import { CREATOR_APP_ID } from "./creatorRead.service";
import { enrichLiveDiscoveryCampaign } from "./liveDiscoveryIdentity.service";

const BASE = "https://business-api.tiktok.com/open_api/v1.3";
const OAUTH = "/oauth2/advertiser/get/", LIST = "/gmv_max/campaign/get/";
const ENRICH = new Set(["/campaign/gmv_max/info/", "/identity/info/", "/gmv_max/store/list/", "/gmv_max/identity/get/"]);
const MAX_CREDENTIAL_ROWS = 200, MAX_GRANTS = 12, MAX_ACCOUNTS = 150;
const MAX_PAGES = 16, PAGE_SIZE = 100, MAX_CAMPAIGNS = 200, MAX_CALLS = 230;
const MAX_BYTES = 1_048_576, REQUEST_TIMEOUT_MS = 6_000, REQUEST_GAP_MS = 850, SCAN_TIMEOUT_MS = 220_000;
const CACHE_MS = 300_000, COOLDOWN_MS = 120_000, THROTTLED_COOLDOWN_MS = 300_000;
const SAFE_ID = /^[1-9]\d{5,30}$/;
const SAFE_TOKEN = /^[\x21-\x7e]{16,4096}$/;
const SAFE_STATUS = /^[A-Z][A-Z0-9_]{0,95}$/;
const SAFE_HANDLE = /^[A-Za-z0-9_.]{1,24}$/;

type Data = Record<string, unknown>;
type Query = Record<string, string | number | object>;
type Credential = { advertiserId: string; token: string };
type Scope = { advertiserId: string; advertiserName: string; token: string; locallyBound: boolean };
export type LiveGmvDiscoveryCampaign = {
  advertiserId: string; advertiserName: string; campaignId: string; campaignName: string;
  secondaryStatus: string | null; kind: "creator" | "shop" | "unknown";
  tiktokUsername: string | null; shopId: string | null; shopName: string | null;
};
export type LiveGmvDiscoverySnapshot = {
  schemaVersion: 1; state: "refreshing" | "ready" | "partial" | "unavailable";
  checkedAt: string | null; accountsChecked: number; accountsTotal: number; campaigns: LiveGmvDiscoveryCampaign[];
};
type Dependencies = {
  appId: string; appSecret: string;
  loadCredentials: () => Promise<{ rows: Credential[]; complete: boolean }>;
  fetchImpl?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>;
  enrich?: typeof enrichLiveDiscoveryCampaign;
};

const record = (v: unknown): v is Data => v !== null && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && SAFE_ID.test(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const unavailable = (checkedAt: string | null): LiveGmvDiscoverySnapshot => ({
  schemaVersion: 1, state: "unavailable", checkedAt, accountsChecked: 0, accountsTotal: 0, campaigns: [],
});

async function parseResponse(response: Response): Promise<Data> {
  if (response.status === 429) throw new Error("DISCOVERY_THROTTLED");
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("DISCOVERY_RESPONSE");
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const value = await reader.read();
      if (value.done) break;
      bytes += value.value.length;
      if (bytes > MAX_BYTES) { void reader.cancel().catch(() => undefined); throw new Error("DISCOVERY_RESPONSE"); }
      chunks.push(Buffer.from(value.value));
    }
    const json: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (record(json) && (json.code === 40100 || json.code === 42900)) throw new Error("DISCOVERY_THROTTLED");
    if (!record(json) || json.code !== 0 || !record(json.data)) throw new Error("DISCOVERY_RESPONSE");
    return json.data;
  } finally { reader.releaseLock(); }
}

/** An isolated, display-only inventory. No result can grant an editor, policy, or budget write. */
export function createLiveGmvDiscoveryScanner({ appId, appSecret, loadCredentials, fetchImpl = fetch, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), enrich = enrichLiveDiscoveryCampaign }: Dependencies) {
  let cached = unavailable(null), pending: Promise<LiveGmvDiscoverySnapshot> | undefined;
  let lastStarted = -Infinity, cooldownUntil = -Infinity;

  async function scanOnce(): Promise<LiveGmvDiscoverySnapshot> {
    if (!id(appId) || typeof appSecret !== "string" || appSecret.length < 8 || appSecret.length > 512) throw new Error("DISCOVERY_OAUTH_UNAVAILABLE");
    const deadline = now() + SCAN_TIMEOUT_MS;
    const credentials = await loadCredentials();
    const groups = new Map<string, Set<string>>();
    let partial = !credentials.complete || credentials.rows.length > MAX_CREDENTIAL_ROWS;
    for (const row of credentials.rows.slice(0, MAX_CREDENTIAL_ROWS)) {
      if (!id(row.advertiserId) || !SAFE_TOKEN.test(row.token)) { partial = true; continue; }
      let accounts = groups.get(row.token);
      if (!accounts) {
        if (groups.size >= MAX_GRANTS) { partial = true; continue; }
        groups.set(row.token, accounts = new Set());
      }
      accounts.add(row.advertiserId);
    }
    const secrets = [appSecret, ...groups.keys()];
    function label(value: unknown, max: number): string | null {
      if (typeof value !== "string") return null;
      const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
      return secrets.some(secret => value.includes(secret) || cleaned.includes(secret)) ? null : cleaned.slice(0, max) || null;
    }
    let lastGet: number | null = null, calls = 0, stopped = false;
    async function request(path: string, params: Query, token: string): Promise<Data> {
      if (path !== OAUTH && path !== LIST && !ENRICH.has(path)) throw new Error("DISCOVERY_PATH");
      if (stopped || calls >= MAX_CALLS || now() >= deadline) { stopped = true; throw new Error("DISCOVERY_LIMIT"); }
      if (lastGet !== null) await sleep(Math.max(0, REQUEST_GAP_MS - (now() - lastGet)));
      lastGet = now();
      if (lastGet >= deadline) { stopped = true; throw new Error("DISCOVERY_LIMIT"); }
      calls++;
      const url = new URL(BASE + path);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      try {
        return await parseResponse(await fetchImpl(url, { method: "GET", redirect: "error",
          headers: { "Access-Token": token, Accept: "application/json", "Cache-Control": "no-store" },
          signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, deadline - lastGet)) }));
      } catch (error) {
        if (error instanceof Error && error.message === "DISCOVERY_THROTTLED") {
          stopped = true;
          cooldownUntil = Math.max(cooldownUntil, now() + THROTTLED_COOLDOWN_MS);
        }
        throw new Error("DISCOVERY_RESPONSE");
      }
    }
    let requestTail: Promise<void> = Promise.resolve();
    function get(path: string, params: Query, token: string): Promise<Data> {
      // Shop identity/name reads may be requested together by enrichment.
      // Serialize starts so even those reads share the same global pace and budget.
      const result = requestTail.then(() => request(path, params, token));
      requestTail = result.then(() => undefined, () => undefined);
      return result;
    }

    const accounts = new Map<string, Scope>();
    let grantsChecked = 0;
    for (const [token, local] of groups) {
      if (stopped) { partial = true; break; }
      try {
        const data = await get(OAUTH, { app_id: appId, secret: appSecret }, token);
        if (!Array.isArray(data.list) || data.list.length > 1_000) throw new Error("DISCOVERY_GRANT_SHAPE");
        const grant = new Map<string, string>();
        for (const item of data.list) {
          if (!record(item) || !id(item.advertiser_id) || grant.has(item.advertiser_id)) throw new Error("DISCOVERY_GRANT_SHAPE");
          grant.set(item.advertiser_id, label(item.advertiser_name, 160) ?? `Ad Account ${item.advertiser_id}`);
        }
        grantsChecked++;
        // OAuth-only advertiser IDs are allowed only using this exact token which just listed them.
        for (const [advertiserId, advertiserName] of grant) {
          const prior = accounts.get(advertiserId), locallyBound = local.has(advertiserId);
          if (!prior || (!prior.locallyBound && locallyBound)) accounts.set(advertiserId, { advertiserId, advertiserName, token, locallyBound });
        }
      } catch { partial = true; }
    }
    if (!grantsChecked) return unavailable(new Date(now()).toISOString());

    const candidates: { scope: Scope; row: LiveGmvDiscoveryCampaign }[] = [];
    let accountsChecked = 0;
    const scopes = [...accounts.values()].sort((a, b) => Number(b.locallyBound) - Number(a.locallyBound) || a.advertiserId.localeCompare(b.advertiserId));
    if (scopes.length > MAX_ACCOUNTS) partial = true;
    for (const scope of scopes.slice(0, MAX_ACCOUNTS)) {
      if (stopped) { partial = true; break; }
      const listed = new Map<string, LiveGmvDiscoveryCampaign | null>();
      let totalPages: number | undefined, totalRows: number | undefined, complete = false;
      try {
        for (let page = 1; page <= MAX_PAGES; page++) {
          const data = await get(LIST, { advertiser_id: scope.advertiserId, filtering: { gmv_max_promotion_types: ["LIVE_GMV_MAX"] },
            fields: ["advertiser_id", "campaign_id", "campaign_name", "operation_status", "secondary_status"], page, page_size: PAGE_SIZE }, scope.token);
          const p = data.page_info;
          if ((data.advertiser_id !== undefined && data.advertiser_id !== scope.advertiserId) || !record(p) || p.page !== page ||
            (p.page_size !== undefined && p.page_size !== PAGE_SIZE) || !integer(p.total_page) || !integer(p.total_number) ||
            !Array.isArray(data.list) || data.list.length > PAGE_SIZE || (p.total_page > 0 && p.total_page < page) ||
            (p.total_page === 0 && (p.total_number !== 0 || data.list.length !== 0)) ||
            (page > 1 && (p.total_page !== totalPages || p.total_number !== totalRows))) throw new Error("DISCOVERY_PAGE");
          totalPages = p.total_page; totalRows = p.total_number;
          const batch = new Map<string, LiveGmvDiscoveryCampaign | null>();
          for (const item of data.list) {
            if (!record(item) || item.advertiser_id !== scope.advertiserId || !id(item.campaign_id) ||
              (item.operation_status !== "ENABLE" && item.operation_status !== "DISABLE" && item.operation_status !== "DELETE") || listed.has(item.campaign_id) ||
              batch.has(item.campaign_id)) throw new Error("DISCOVERY_CAMPAIGN");
            const secondaryStatus = label(item.secondary_status, 96);
            batch.set(item.campaign_id, item.operation_status === "ENABLE" ? {
              advertiserId: scope.advertiserId, advertiserName: scope.advertiserName, campaignId: item.campaign_id,
              campaignName: label(item.campaign_name, 160) ?? `Campaign ${item.campaign_id}`,
              secondaryStatus: secondaryStatus && SAFE_STATUS.test(secondaryStatus) ? secondaryStatus : null,
              kind: "unknown", tiktokUsername: null, shopId: null, shopName: null,
            } : null);
          }
          if (listed.size + batch.size > totalRows) throw new Error("DISCOVERY_PAGE");
          for (const [key, value] of batch) listed.set(key, value);
          if (page >= totalPages) { complete = listed.size === totalRows; break; }
        }
      } catch { /* A failed page never counts as complete; prior exact pages remain usable. */ }
      if (complete) accountsChecked++; else partial = true;
      for (const row of listed.values()) if (row) {
        if (candidates.length >= MAX_CAMPAIGNS) { partial = true; break; }
        candidates.push({ scope, row });
      }
    }

    // Prioritize coverage for every account, then enrich exact ENABLE rows. A missing metadata field is not a guessed username.
    const campaigns: LiveGmvDiscoveryCampaign[] = [];
    const storeLists = new Map<string, Promise<Data>>();
    for (const { scope, row } of candidates) {
      if (stopped) { partial = true; campaigns.push(row); continue; }
      try {
        const verified = await enrich({ advertiserId: scope.advertiserId, campaignId: row.campaignId,
          get: (path, query) => {
            if (!ENRICH.has(path) || query.advertiser_id !== scope.advertiserId) throw new Error("DISCOVERY_ENRICH_SCOPE");
            if (path === "/gmv_max/store/list/") {
              const key = JSON.stringify(query);
              const previous = storeLists.get(key);
              if (previous) return previous;
              const current = get(path, query, scope.token).catch(error => { storeLists.delete(key); throw error; });
              storeLists.set(key, current);
              return current;
            }
            return get(path, query, scope.token);
          } });
        if (verified.enabled === false) continue;
        const kind = verified.kind === "creator" || verified.kind === "shop" ? verified.kind : "unknown";
        if (kind === "unknown") partial = true;
        const handle = label(verified.tiktokUsername, 24);
        campaigns.push({ ...row, kind, tiktokUsername: handle && SAFE_HANDLE.test(handle) ? handle : null,
          shopId: kind === "shop" && id(verified.shopId) ? verified.shopId : null,
          shopName: kind === "shop" ? label(verified.shopName, 160) : null });
      } catch { partial = true; campaigns.push(row); }
    }
    return { schemaVersion: 1, state: partial || stopped ? "partial" : "ready", checkedAt: new Date(now()).toISOString(),
      accountsChecked, accountsTotal: accounts.size, campaigns };
  }

  function snapshot(): LiveGmvDiscoverySnapshot { return pending ? { ...cached, state: "refreshing" } : cached; }
  function begin(force: boolean): void {
    const at = now(), checkedAt = cached.checkedAt ? Date.parse(cached.checkedAt) : -Infinity;
    if (pending || at < cooldownUntil || at - lastStarted < COOLDOWN_MS || (!force && at - checkedAt < CACHE_MS)) return;
    lastStarted = at;
    pending = Promise.resolve().then(scanOnce).catch(() => unavailable(new Date(now()).toISOString()))
      .then(result => { cached = result; return result; }).finally(() => {
        cooldownUntil = Math.max(cooldownUntil, now() + 45_000);
        pending = undefined;
      });
  }
  return {
    snapshot,
    read() { begin(false); return snapshot(); },
    refresh() { begin(true); return snapshot(); },
    async scan() { begin(true); return pending ?? cached; },
  };
}

export function createProductionLiveGmvDiscoveryScanner() {
  return createLiveGmvDiscoveryScanner({ appId: config.tiktokOAuth.appId, appSecret: config.tiktokOAuth.appSecret,
    async loadCredentials() {
      if (config.tiktokOAuth.appId !== CREATOR_APP_ID) throw new Error("DISCOVERY_APP_SCOPE");
      const { AppDataSource } = await import("../db/dataSource");
      const runner = AppDataSource.createQueryRunner();
      let encrypted: unknown;
      try {
        await runner.connect();
        await runner.query("BEGIN READ ONLY");
        await runner.query("SET LOCAL statement_timeout = '5s'");
        const mode = await runner.query("SHOW transaction_read_only");
        if (mode[0]?.transaction_read_only !== "on") throw new Error("DISCOVERY_DB_SCOPE");
        encrypted = await runner.query(`SELECT advertiser_id, access_token FROM (
          SELECT DISTINCT ON (advertiser_id) advertiser_id, access_token, authorized_at
          FROM oauth_tokens WHERE revoked_at IS NULL AND authorized_at IS NOT NULL
          ORDER BY advertiser_id, authorized_at DESC, id DESC
        ) scoped ORDER BY authorized_at DESC, advertiser_id LIMIT $1`, [MAX_CREDENTIAL_ROWS + 1]);
      } finally {
        try { await runner.query("ROLLBACK"); } finally { await runner.release(); }
      }
      if (!Array.isArray(encrypted)) throw new Error("DISCOVERY_DB_SCOPE");
      const raw = encrypted.slice(0, MAX_CREDENTIAL_ROWS);
      const valid = raw.filter((r): r is { advertiser_id: string; access_token: string } => record(r) && id(r.advertiser_id) &&
        typeof r.access_token === "string" && r.access_token.length <= 8_192);
      const tokens = await decryptSecretBatch(valid.map(r => r.access_token));
      const rows = valid.flatMap((r, i) => tokens[i] ? [{ advertiserId: r.advertiser_id, token: tokens[i]! }] : []);
      return { rows, complete: encrypted.length <= MAX_CREDENTIAL_ROWS && raw.length === rows.length };
    },
  });
}
