import { describe, expect, it, vi } from "vitest";
import { createLiveGmvDiscoveryScanner } from "./liveGmvDiscovery.service";

const APP = "7667234745498992657", SECRET = "discovery-test-secret";
const TA = "test-discovery-token-one", TB = "test-discovery-token-two";
const A = "7666005333864644624", B = "7669107155332808725", C = "7436220526475165713";
const ID = "1881374445967426", OTHER = "1880626319364530";
const grant = (...entries: [string, string][]) => ({ list: entries.map(([advertiser_id, advertiser_name]) => ({ advertiser_id, advertiser_name })) });
const campaign = (advertiser_id: string, campaign_id = ID, operation_status = "ENABLE", campaign_name = "Live Campaign") =>
  ({ advertiser_id, campaign_id, operation_status, campaign_name, secondary_status: "CAMPAIGN_STATUS_ENABLE" });
const page = (list: unknown[], number = 1, pages = 1, total = list.length) => ({ list, page_info: { page: number, total_page: pages, total_number: total } });
const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
const standardEnrichment = { kind: "creator" as const, tiktokUsername: "verified.creator", shopId: null, shopName: null };

function setup(reply: (url: URL, token: string) => Response | Promise<Response>, options: Partial<Parameters<typeof createLiveGmvDiscoveryScanner>[0]> = {}) {
  let at = 1_762_772_400_000;
  const requests: { path: string; token: string; at: number; params: URLSearchParams }[] = [];
  const loadCredentials = vi.fn(async () => ({ rows: [{ advertiserId: A, token: TA }], complete: true }));
  const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    const url = new URL(input.toString()), token = new Headers(init?.headers).get("Access-Token")!;
    expect(url.origin).toBe("https://business-api.tiktok.com");
    const path = url.pathname.replace("/open_api/v1.3", "");
    requests.push({ path, token, at, params: url.searchParams });
    return reply(url, token);
  });
  const scanner = createLiveGmvDiscoveryScanner({ appId: APP, appSecret: SECRET, loadCredentials,
    fetchImpl, now: () => at, sleep: async ms => { at += ms; }, enrich: async () => standardEnrichment, ...options });
  return { scanner, requests, loadCredentials, advance: (ms: number) => { at += ms; } };
}

describe("read-only LIVE GMV Max discovery", () => {
  it("coalesces refreshes, merges only verified grants, and includes exact OAuth-only advertisers", async () => {
    const f = setup((u, token) => {
      if (u.pathname.endsWith("/oauth2/advertiser/get/")) {
        expect(u.searchParams.get("app_id")).toBe(APP);
        expect(u.searchParams.get("secret")).toBe(SECRET);
        return ok(token === TA ? grant([A, "Ppan"], [C, `Shop ${SECRET}`]) : grant([B, "Partner"], [A, "Not preferred"]));
      }
      expect(u.searchParams.has("secret")).toBe(false);
      expect(JSON.parse(u.searchParams.get("filtering")!)).toEqual({ gmv_max_promotion_types: ["LIVE_GMV_MAX"] });
      const advertiser = u.searchParams.get("advertiser_id")!;
      expect(token).toBe(advertiser === B ? TB : TA);
      return ok(advertiser === A ? page([campaign(A), campaign(A, OTHER, "DISABLE")]) : advertiser === C
        ? page([campaign(C, OTHER, "ENABLE", `name ${TA}`)]) : page([]));
    }, { loadCredentials: async () => ({ rows: [{ advertiserId: A, token: TA }, { advertiserId: B, token: TB }, { advertiserId: A, token: TA }], complete: true }) });
    expect(f.scanner.snapshot()).toMatchObject({ state: "unavailable", checkedAt: null });
    expect(f.requests).toEqual([]);
    expect(f.scanner.read().state).toBe("refreshing");
    expect(f.scanner.refresh().state).toBe("refreshing");
    const [data, same] = await Promise.all([f.scanner.scan(), f.scanner.scan()]);
    expect(same).toEqual(data);
    expect(data).toMatchObject({ schemaVersion: 1, state: "ready", accountsTotal: 3, accountsChecked: 3,
      campaigns: [{ advertiserId: A, advertiserName: "Ppan", campaignId: ID, tiktokUsername: "verified.creator" },
        { advertiserId: C, advertiserName: `Ad Account ${C}`, campaignId: OTHER, campaignName: `Campaign ${OTHER}` }] });
    expect(f.requests.map(r => r.path)).toEqual(["/oauth2/advertiser/get/", "/oauth2/advertiser/get/", ...Array(3).fill("/gmv_max/campaign/get/")]);
    expect(f.requests.every((r, i) => i === 0 || r.at - f.requests[i - 1].at >= 850)).toBe(true);
    expect(JSON.stringify(data)).not.toContain(SECRET);
    expect(JSON.stringify(data)).not.toContain(TA);
    expect(f.scanner.read()).toEqual(data);
    expect(f.scanner.refresh()).toEqual(data);
  });

  it("uses every verified page, never counts a corrupt page as complete or a foreign campaign as open", async () => {
    const f = setup(u => {
      if (u.pathname.endsWith("/oauth2/advertiser/get/")) return ok(grant([A, "Ppan"], [B, "Partner"]));
      const account = u.searchParams.get("advertiser_id"), currentPage = u.searchParams.get("page");
      if (account === B) return ok(page([campaign(B, OTHER, "DELETE")]));
      return ok(currentPage === "1" ? page([campaign(A)], 1, 2, 2) : page([campaign(C, OTHER)], 2, 2, 2));
    });
    const data = await f.scanner.scan();
    expect(data).toMatchObject({ state: "partial", accountsTotal: 2, accountsChecked: 1, campaigns: [{ advertiserId: A, campaignId: ID }] });
    expect(f.requests.filter(r => r.params.get("advertiser_id") === A)).toHaveLength(2);
  });

  it("serializes parallel metadata requests and drops a newer verified disabled or non-LIVE detail", async () => {
    const f = setup(u => {
      if (u.pathname.endsWith("/oauth2/advertiser/get/")) return ok(grant([A, "Ppan"]));
      return u.pathname.endsWith("/gmv_max/campaign/get/") ? ok(page([campaign(A), campaign(A, OTHER)])) : ok({});
    }, { enrich: async ({ advertiserId, campaignId, get }) => {
      const args = { advertiser_id: advertiserId, campaign_id: campaignId };
      await Promise.all([get("/campaign/gmv_max/info/", args), get("/gmv_max/store/list/", { advertiser_id: advertiserId })]);
      return campaignId === OTHER ? { ...standardEnrichment, enabled: false } : {
        kind: "shop", tiktokUsername: "verified.shop", shopId: C, shopName: "Shop Name",
      };
    } });
    const data = await f.scanner.scan();
    expect(data.campaigns).toMatchObject([{ campaignId: ID, kind: "shop", shopId: C, shopName: "Shop Name", tiktokUsername: "verified.shop" }]);
    expect(f.requests).toHaveLength(5);
    expect(f.requests.filter(r => r.path === "/gmv_max/store/list/")).toHaveLength(1);
    expect(f.requests.every((r, i) => i === 0 || r.at - f.requests[i - 1].at >= 850)).toBe(true);
  });

  it("fails closed on rate limiting, suppresses queued enrichment and automatic/manual retry during backoff", async () => {
    const f = setup(u => {
      if (u.pathname.endsWith("/oauth2/advertiser/get/")) return ok(grant([A, "Ppan"], [B, "Partner"]));
      if (u.searchParams.get("advertiser_id") === A) return ok(page([campaign(A)]));
      return new Response("rate limit", { status: 429 });
    });
    const data = await f.scanner.scan();
    expect(data).toMatchObject({ state: "partial", accountsTotal: 2, accountsChecked: 1, campaigns: [{ campaignId: ID, kind: "unknown", tiktokUsername: null }] });
    expect(f.requests).toHaveLength(3);
    f.advance(121_000);
    expect(f.scanner.refresh()).toEqual(data);
    expect(f.requests).toHaveLength(3);
    f.advance(180_000);
    await f.scanner.scan();
    expect(f.requests).toHaveLength(6);
  });

  it("does not keep a ready view after failed grant revalidation", async () => {
    let failed = false;
    const f = setup(u => u.pathname.endsWith("/oauth2/advertiser/get/") ? failed ? new Response("unavailable", { status: 503 }) : ok(grant([A, "Ppan"])) : ok(page([campaign(A)])));
    expect((await f.scanner.scan()).campaigns).toHaveLength(1);
    f.advance(300_001);
    failed = true;
    expect(f.scanner.read()).toMatchObject({ state: "refreshing", campaigns: [{ campaignId: ID }] });
    expect(await f.scanner.scan()).toMatchObject({ state: "unavailable", accountsTotal: 0, accountsChecked: 0, campaigns: [] });
  });
});
