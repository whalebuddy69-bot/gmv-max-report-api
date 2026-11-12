import { describe, expect, it, vi } from "vitest";
import { createBubpaBudgetRecoveryEvidenceReader } from "./creatorBudgetRecovery.adapters";
import type { AutomationVerifiedCreatorBinding } from "./creatorAutomationRegistry.service";
import { validCreatorBudgetRecoveryEvidence } from "./creatorBudgetRecovery.store";

const OLD = "1881580307345762", CURRENT = "1881670184981538", OTHER = "1881670184981539";
const NOW = "2026-11-12T17:47:30.000Z", TOKEN = "synthetic-bubpa-recovery-token-never-real";
const BINDING: AutomationVerifiedCreatorBinding = { clientId: "bubpa_shop189", advertiserId: "7632368323640115207",
  tiktokAccountId: "7235929905719148546", identityId: "af94e7ff-cf71-5a99-8cf0-9d41b911d006",
  identityType: "BC_AUTH_TT", identityAuthorizedBcId: "7627179356976201745" };
const FLAGS = { CREATOR_READ_ENABLED: "true", CREATOR_WEB_BUDGET_LIVE_ENABLED: "true",
  CREATOR_WEB_BUBPA_SHOP189_BUDGET_MODE: "live", CREATOR_WEB_BUBPA_SHOP189_BUDGET_LIVE_ENABLED: "true",
  CREATOR_AUTO_BUDGET_BUBPA_SHOP189_MODE: "live", CREATOR_AUTO_BUDGET_BUBPA_SHOP189_LIVE_ENABLED: "true" };
const request = { recoveryId: "bd40b02d-6b7d-4fb7-95f9-5943d79e5272", oldOperationId: "b2645635-beac-4cac-a072-5adecf8b7bbc",
  oldCampaignId: OLD, newCampaignId: CURRENT, acknowledgedUnknown: true as const };

function detail(campaignId: string) {
  return { advertiser_id: BINDING.advertiserId, campaign_id: campaignId, campaign_name: "Offline fixture",
    operation_status: campaignId === OLD ? "DISABLE" : "ENABLE", shopping_ads_type: "LIVE", store_id: "0", store_authorized_bc_id: "0",
    optimization_goal: "VALUE", deep_bid_type: "VO_MIN_ROAS", budget: campaignId === OLD ? 2400 : 2000, roas_bid: campaignId === OLD ? 10 : 4.5,
    schedule_type: "SCHEDULE_FROM_NOW", schedule_start_time: "2026-11-12 17:02:29", schedule_end_time: "2036-11-09 17:02:29",
    promotion_days: { is_enabled: false }, identity_list: [{ identity_id: BINDING.identityId, identity_type: BINDING.identityType,
      identity_authorized_bc_id: BINDING.identityAuthorizedBcId, store_id: null, identity_authorized_shop_id: null }] };
}
type Options = {
  total?: number; duplicate?: boolean; competing?: boolean; expiredCompetitor?: boolean; badCompetitorSchedule?: boolean;
  currency?: string; timezone?: string; oldListStatus?: string; advanceMs?: number; startAt?: string; noRoom?: boolean;
  mutateInfo?: (data: ReturnType<typeof detail> & Record<string, unknown>, read: number) => void;
  mutateList?: (data: Record<string, any>, exactReads: number) => void;
  fetchFailure?: boolean; providerCode?: number; oversized?: boolean;
};
function harness(options: Options = {}) {
  const calls: { path: string; query: URLSearchParams }[] = [], counts = new Map<string, number>(), listCounts = new Map<string, number>();
  let at = Date.parse(options.startAt ?? NOW), loads = 0, roi = 4.5;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://business-api.tiktok.com"); expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error"); expect(init?.cache).toBe("no-store"); expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("Access-Token")).toBe(TOKEN);
    expect(new Headers(init?.headers).get("X-Creator-Web-Key")).toBeNull();
    calls.push({ path: url.pathname, query: url.searchParams });
    at += options.advanceMs ?? 0;
    if (options.fetchFailure) throw new Error(`private error ${TOKEN}`);
    if (options.oversized) return new Response(TOKEN, { headers: { "content-length": "1048577" } });
    let data: Record<string, any>;
    if (url.pathname.endsWith("/advertiser/info/")) {
      expect(url.searchParams.get("advertiser_ids")).toBe(JSON.stringify([BINDING.advertiserId]));
      data = { list: [{ advertiser_id: BINDING.advertiserId, currency: options.currency ?? "THB", timezone: options.timezone ?? "Asia/Bangkok" }] };
    } else {
      expect(url.searchParams.get("advertiser_id")).toBe(BINDING.advertiserId);
      if (url.pathname.endsWith("/campaign/gmv_max/info/")) {
        const campaignId = url.searchParams.get("campaign_id")!, read = (counts.get(campaignId) ?? 0) + 1;
        counts.set(campaignId, read);
        data = detail(campaignId);
        if (campaignId === CURRENT) data.roas_bid = roi;
        if (campaignId === OTHER && options.expiredCompetitor) {
          data.schedule_type = "SCHEDULE_START_END"; data.schedule_start_time = "2026-11-10 00:00:00";
          data.schedule_end_time = "2026-11-11 00:00:00";
        }
        if (campaignId === OTHER && options.badCompetitorSchedule) delete data.schedule_start_time;
        options.mutateInfo?.(data as ReturnType<typeof detail>, read);
      } else if (url.pathname.endsWith("/gmv_max/campaign/get/")) {
        const filtering = JSON.parse(url.searchParams.get("filtering")!), exactId = filtering.campaign_ids?.[0] as string | undefined;
        let list: Record<string, unknown>[];
        if (exactId) {
          const reads = (listCounts.get(exactId) ?? 0) + 1; listCounts.set(exactId, reads);
          list = [{ advertiser_id: BINDING.advertiserId, campaign_id: exactId,
            operation_status: exactId === OLD ? options.oldListStatus ?? "DISABLE" : "ENABLE", modify_time: "2026-11-12 17:45:47" }];
          data = { list, page_info: { page: 1, total_page: 1, total_number: 1 } };
          options.mutateList?.(data, reads);
        } else {
          const extra = options.competing || options.expiredCompetitor || options.badCompetitorSchedule;
          const total = options.total ?? (extra ? 3 : 2), ids = [OLD, ...(extra ? [OTHER] : []),
            ...Array.from({ length: Math.max(0, total - (extra ? 3 : 2)) }, (_, n) => String(1900000000000000 + n)), CURRENT];
          if (options.duplicate && ids.length > 100) ids[100] = OLD;
          const page = Number(url.searchParams.get("page"));
          list = ids.slice((page - 1) * 100, page * 100).map(campaign_id => ({ advertiser_id: BINDING.advertiserId, campaign_id,
            operation_status: campaign_id === CURRENT || campaign_id === OTHER ? "ENABLE" : "DISABLE" }));
          data = { list, page_info: { page, total_page: Math.ceil(total / 100), total_number: total } };
          options.mutateList?.(data, 0);
        }
      } else if (url.pathname.endsWith("/gmv_max/report/get/")) {
        expect(url.searchParams.get("filtering")).toBe(JSON.stringify({ campaign_ids: [CURRENT] }));
        const list = options.noRoom ? [] : [{ dimensions: { room_id: "1234567890123456", stat_time_day: "2026-11-13 00:00:00" },
          metrics: { live_status: "ONGOING", live_launched_time: "2026-11-12 17:05:00", cost: "12.34" } }];
        data = { list, page_info: { page: 1, page_size: 20, total_page: list.length ? 1 : 0, total_number: list.length } };
      } else {
        expect(url.pathname).toBe("/open_api/v1.3/identity/live/get/");
        expect(url.searchParams.get("identity_id")).toBe(BINDING.identityId);
        data = { live_list: [{ live_id: "1234567890123456", finish_timestamp: "1970-01-01 00:00:00" }] };
      }
    }
    return Response.json({ code: options.providerCode ?? 0, request_id: "offline-read-request", data });
  }) satisfies typeof fetch;
  const binding = { ...BINDING }, env = { ...FLAGS };
  const reader = createBubpaBudgetRecoveryEvidenceReader({ binding, env, fetchImpl, now: () => new Date(at), sleep: async () => {},
    loadToken: async () => { loads++; return TOKEN; } });
  return { calls, counts, binding, env, reader, get loads() { return loads; }, setRoi(value: number) { roi = value; }, get now() { return new Date(at); } };
}

describe("read-only Bubpa different-campaign recovery evidence", () => {
  it("proves exact scoped old DISABLE/new ENABLE using only GET and existing pre-arm fingerprints", async () => {
    const h = harness({ total: 249 }), evidence = await h.reader(OLD, CURRENT);
    expect(evidence).toMatchObject({ clientId: "bubpa_shop189", advertiserId: BINDING.advertiserId, oldCampaignId: OLD,
      oldOperationStatus: "DISABLE", oldListOperationStatus: "DISABLE", oldBudgetMinor: 240000,
      newCampaignId: CURRENT, newOperationStatus: "ENABLE", newListOperationStatus: "ENABLE", soleEnabledCampaignId: CURRENT,
      newBudgetMinor: 200000, nativeAutoState: "UNKNOWN", observedAt: NOW });
    expect(validCreatorBudgetRecoveryEvidence(evidence, request, h.now)).toBe(true);
    expect(evidence.identityFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.newFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(h.loads).toBe(1);
    expect(h.calls.filter(c => c.path.endsWith("/gmv_max/campaign/get/") && !JSON.parse(c.query.get("filtering")!).campaign_ids)).toHaveLength(3);
    expect(h.calls.some(c => /lease|finish|update|policy/.test(c.path))).toBe(false);
    expect(JSON.stringify(evidence)).not.toContain(TOKEN);
    expect(evidence).not.toHaveProperty("historicalOutcomeResolved");
  });

  it("does not equate absent LIVE evidence with permission to mutate or with historical write resolution", async () => {
    const h = harness({ noRoom: true });
    const evidence = await h.reader(OLD, CURRENT);
    expect(validCreatorBudgetRecoveryEvidence(evidence, request, h.now)).toBe(true);
    expect(h.calls.every(c => !c.path.includes("update"))).toBe(true);
  });

  it("ignores only positively proven expired fixed-schedule enabled competitors", async () => {
    const h = harness({ expiredCompetitor: true });
    expect((await h.reader(OLD, CURRENT)).soleEnabledCampaignId).toBe(CURRENT);
    await expect(harness({ competing: true }).reader(OLD, CURRENT)).rejects.toThrow("BUBPA_RECOVERY_EVIDENCE_UNVERIFIED");
    await expect(harness({ badCompetitorSchedule: true }).reader(OLD, CURRENT)).rejects.toThrow("BUBPA_RECOVERY_EVIDENCE_UNVERIFIED");
  });

  it.each([
    ["currency", { currency: "USD" }], ["timezone", { timezone: "UTC" }],
    ["old LIST status", { oldListStatus: "ENABLE" }], ["duplicate inventory", { total: 249, duplicate: true }],
    ["oversized inventory", { total: 501 }], ["provider code", { providerCode: 40001 }],
    ["response boundary", { oversized: true }], ["transport", { fetchFailure: true }],
  ] as const)("rejects unverified %s with a safe error", async (_label, options) => {
    const h = harness(options);
    await expect(h.reader(OLD, CURRENT)).rejects.toThrow(/^BUBPA_RECOVERY_EVIDENCE_UNVERIFIED$/);
  });

  it.each([
    ["old INFO status", (d: any) => { if (d.campaign_id === OLD) d.operation_status = "ENABLE"; }],
    ["advertiser", (d: any) => { d.advertiser_id = "7666005333864644624"; }],
    ["identity", (d: any) => { d.identity_list[0].identity_id = "other-identity"; }],
    ["BC", (d: any) => { d.identity_list[0].identity_authorized_bc_id = "1234567890123456"; }],
    ["Shop", (d: any) => { d.store_id = "1234567890123456"; }],
    ["nested Shop", (d: any) => { d.identity_list[0].identity_authorized_shop_id = "1234567890123456"; }],
    ["numeric account", (d: any) => { d.tiktok_account_id = "1234567890123456"; }],
    ["goal", (d: any) => { d.optimization_goal = "VO_MIN_ROAS"; }],
    ["native enabled", (d: any) => { d.auto_budget_enabled = true; }],
    ["nested native", (d: any) => { d.auto_budget = { is_enabled: true }; }],
    ["promotion enabled", (d: any) => { d.promotion_days.is_enabled = true; }],
    ["native conflict", (d: any) => { d.auto_budget_enabled = "true"; }],
    ["new expired", (d: any) => { if (d.campaign_id === CURRENT) { d.schedule_type = "SCHEDULE_START_END";
      d.schedule_start_time = "2026-11-10 00:00:00"; d.schedule_end_time = "2026-11-11 00:00:00"; } }],
  ])("rejects %s", async (_label, mutateInfo) => {
    await expect(harness({ mutateInfo }).reader(OLD, CURRENT)).rejects.toThrow("BUBPA_RECOVERY_EVIDENCE_UNVERIFIED");
  });

  it.each(["budget", "roas_bid", "campaign_name", "schedule_end_time"])("detects within-read concurrent %s edits", async field => {
    const h = harness({ mutateInfo: (data, read) => {
      if (data.campaign_id === CURRENT && read >= 2) {
        if (field === "budget") data.budget = 2100;
        else if (field === "roas_bid") data.roas_bid = 6;
        else if (field === "campaign_name") data.campaign_name = "changed by another writer";
        else data.schedule_end_time = "2036-11-09 17:02:28";
      }
    } });
    await expect(h.reader(OLD, CURRENT)).rejects.toThrow("BUBPA_RECOVERY_EVIDENCE_UNVERIFIED");
  });

  it("uses LIST timestamp rather than info.modify_time and rejects drift at the last exact read", async () => {
    const h = harness({ mutateInfo: data => { data.modify_time = "not-authoritative"; }, mutateList: (data, reads) => {
      if (reads >= 3 && data.list[0]?.campaign_id === CURRENT) data.list[0].modify_time = "2026-11-12 17:46:00";
    } });
    await expect(h.reader(OLD, CURRENT)).rejects.toThrow("BUBPA_RECOVERY_EVIDENCE_UNVERIFIED");
  });

  it("timestamps the earliest actual GET and refuses an expired whole-read window or day rollover", async () => {
    const h = harness({ advanceMs: 200 });
    const evidence = await h.reader(OLD, CURRENT);
    expect(evidence.observedAt).toBe(NOW); expect(h.now.getTime()).toBeGreaterThan(Date.parse(evidence.observedAt));
    await expect(harness({ advanceMs: 3000 }).reader(OLD, CURRENT)).rejects.toThrow("BUBPA_RECOVERY_EVIDENCE_UNVERIFIED");
    await expect(harness({ startAt: "2026-11-12T16:59:59.000Z", advanceMs: 2000 }).reader(OLD, CURRENT)).rejects.toThrow("BUBPA_RECOVERY_EVIDENCE_UNVERIFIED");
  });

  it("allows separate fresh evidence calls to observe a new ROI baseline without changing identity proof", async () => {
    const h = harness(), first = await h.reader(OLD, CURRENT);
    h.setRoi(6);
    const second = await h.reader(OLD, CURRENT);
    expect(first.identityFingerprint).toBe(second.identityFingerprint);
    expect(first.newSettingsFingerprint).not.toBe(second.newSettingsFingerprint);
    expect(first.newNonRoiSettingsFingerprint).toBe(second.newNonRoiSettingsFingerprint);
  });

  it("is default-off without current scope authority, immutable to later caller edits, and rejects same-campaign reuse", async () => {
    let loads = 0;
    const off = createBubpaBudgetRecoveryEvidenceReader({ binding: BINDING, env: {}, loadToken: async () => { loads++; return TOKEN; } });
    await expect(off(OLD, CURRENT)).rejects.toThrow("BUBPA_RECOVERY_EVIDENCE_UNVERIFIED"); expect(loads).toBe(0);
    const h = harness(); h.binding.advertiserId = "1234567890123456"; h.env.CREATOR_READ_ENABLED = "false";
    expect((await h.reader(OLD, CURRENT)).advertiserId).toBe(BINDING.advertiserId);
    await expect(h.reader(OLD, OLD)).rejects.toThrow("BUBPA_RECOVERY_EVIDENCE_UNVERIFIED");
    expect(() => createBubpaBudgetRecoveryEvidenceReader({ binding: { ...BINDING, clientId: "boomkan" }, loadToken: async () => TOKEN })).toThrow("BUBPA_RECOVERY_EVIDENCE_UNVERIFIED");
  });

  it("bounds an unresponsive fetch without exposing its credential", async () => {
    vi.useFakeTimers();
    try {
      const reader = createBubpaBudgetRecoveryEvidenceReader({ binding: BINDING, env: FLAGS, loadToken: async () => TOKEN,
        now: () => new Date(NOW), fetchImpl: () => new Promise(() => {}), sleep: async () => {} });
      const rejection = expect(reader(OLD, CURRENT)).rejects.toThrow(/^BUBPA_RECOVERY_EVIDENCE_UNVERIFIED$/);
      await vi.advanceTimersByTimeAsync(5001);
      await rejection;
    } finally { vi.useRealTimers(); }
  });
});
