import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CREATOR_BINDING as B } from "./creatorRead.service";
import { createPpanCampaignActionProvider, type CampaignSwitch } from "./creatorCampaignActions.provider";
import { configuredPpanCampaignActionMode, createPpanCampaignActions } from "./creatorCampaignActions.service";
import { createPpanCampaignActionStore, type CampaignActionPlan } from "./creatorCampaignActions.store";
import { createCreatorWebBudgetStore } from "./creatorWebBudget.store";
import { createCreatorAutoBudgetGrantStore } from "./creatorAutoBudget.policy";
import { createCreatorContinuousAutoBudgetStore } from "./creatorContinuousAutoBudget.store";

const ID = "91900000000001", OTHER = "91900000000002", OWNER = 10, TOKEN = "fixture_campaign_token_valid";
const dbs: PGlite[] = [];
afterEach(async () => { for (const db of dbs.splice(0)) await db.close(); });

function fixture({ wrongIdentity = false, multi = false, mismatch = false, unknown = false, budget = 500 }: {
  wrongIdentity?: boolean; multi?: boolean; mismatch?: boolean; unknown?: boolean; budget?: number } = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  let operation: CampaignSwitch = "ENABLE", roi = 3.5, modified = "2025-02-15 08:00:00";
  const response = (data: unknown) => Response.json({ code: 0, data });
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = new URL(String(input)), method = init?.method ?? "GET", body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, body });
    expect(u.hostname).toBe("business-api.tiktok.com");
    expect(new Headers(init?.headers).get("Access-Token")).toBe(TOKEN);
    if (method === "POST") {
      if (unknown) throw new Error("network outcome not known");
      modified = "2025-02-15 10:00:02";
      if (u.pathname.endsWith("/campaign/status/update/")) {
        operation = body.operation_status;
        return response({ campaign_ids: [ID], status: operation });
      }
      if (u.pathname.endsWith("/campaign/gmv_max/update/")) { roi = body.roas_bid; return response({ campaign_id: ID }); }
      throw new Error("wrong provider POST");
    }
    expect(u.searchParams.get("advertiser_id")).toBe(B.advertiserId);
    if (u.pathname.endsWith("/gmv_max/campaign/get/")) {
      const filter = JSON.parse(u.searchParams.get("filtering") ?? "{}"), isExact = !!filter.campaign_ids;
      if (isExact) expect(filter.campaign_ids).toEqual([ID]);
      const list = [{ advertiser_id: B.advertiserId, campaign_id: ID, operation_status: operation, modify_time: modified }];
      if (!isExact && multi) list.push({ advertiser_id: B.advertiserId, campaign_id: OTHER, operation_status: "ENABLE", modify_time: modified });
      return response({ list, page_info: { page: 1, total_page: 1, total_number: list.length } });
    }
    if (u.pathname.endsWith("/campaign/gmv_max/info/")) {
      expect(u.searchParams.get("campaign_id")).toBe(ID);
      return response({ advertiser_id: B.advertiserId, campaign_id: ID, operation_status: operation, shopping_ads_type: "LIVE",
        store_id: "0", store_authorized_bc_id: "0", deep_bid_type: "VO_MIN_ROAS", optimization_goal: "VALUE",
        identity_list: [{ identity_id: wrongIdentity ? "other" : B.identityId, identity_type: B.identityType, identity_authorized_bc_id: B.identityAuthorizedBcId }],
        budget: mismatch && calls.some(c => c.method === "POST") ? budget + 1 : budget, roas_bid: roi,
        campaign_name: "Test Ppan", schedule_type: "FROM_NOW", schedule_start_time: "2025-02-15 07:00:00", auto_budget_enabled: false });
    }
    throw new Error("unexpected GET");
  }) as typeof fetch;
  const provider = createPpanCampaignActionProvider({ fetchImpl, loadToken: async () => TOKEN, now: () => new Date("2025-02-15T10:00:00.000Z") });
  return { provider, calls, setStatus: (s: CampaignSwitch) => { operation = s; } };
}

function memory() {
  const records = new Map<string, CampaignActionPlan & { status: "PREPARED" | "PROCESSING" | "APPLIED_VERIFIED" | "OUTCOME_UNKNOWN" | "NOT_SENT" }>();
  const store: ReturnType<typeof createPpanCampaignActionStore> = {
    ensureSchema: vi.fn(async () => {}), findBlocker: vi.fn(async () => null), lastPausedId: vi.fn(async () => null),
    create: vi.fn(async p => { records.set(p.operationId, { ...p, status: "PREPARED" }); }),
    get: vi.fn(async (owner, op) => records.get(op)?.ownerId === owner ? records.get(op)! : null),
    reserve: vi.fn(async (owner, op) => { const row = records.get(op); if (row?.ownerId !== owner || row.status !== "PREPARED") return null; row.status = "PROCESSING"; return row; }),
    canDispatch: vi.fn(async () => true),
    finish: vi.fn(async (_, op, status) => { const row = records.get(op)!; row.status = status; return row; }),
  };
  return store;
}

describe("Ppan no-Shop Creator campaign controls", () => {
  it("keeps dry-run default, live allowlists independent, and refuses legacy test co-execution", () => {
    const env = { CREATOR_READ_ENABLED: "true", CREATOR_PPAN_CAMPAIGN_ACTIONS_MODE: "live", CREATOR_PPAN_CAMPAIGN_OPERATOR_FENCE_VERIFIED: "true",
      CREATOR_PPAN_CAMPAIGN_ROI_LIVE_VERIFIED: "true" };
    expect(configuredPpanCampaignActionMode("SET_ROI", {})).toBe("disabled");
    expect(configuredPpanCampaignActionMode("SET_ROI", { CREATOR_READ_ENABLED: "true" })).toBe("dry-run");
    expect(configuredPpanCampaignActionMode("SET_ROI", env)).toBe("live");
    expect(configuredPpanCampaignActionMode("PAUSE", env)).toBe("dry-run");
    expect(configuredPpanCampaignActionMode("RESUME", { ...env, CREATOR_PPAN_CAMPAIGN_PAUSE_LIVE_VERIFIED: "true" })).toBe("dry-run");
    expect(configuredPpanCampaignActionMode("SET_ROI", { ...env, CREATOR_BUDGET_TEST_ENABLED: "true" })).toBe("dry-run");
  });

  it("offers safe before/after preview without any write, even when Auto is active", async () => {
    const { provider, calls } = fixture(), store = memory();
    vi.mocked(store.findBlocker).mockResolvedValue("AUTO_ACTIVE");
    const s = createPpanCampaignActions({ provider, store, mode: () => "dry-run", readPolicy: vi.fn() });
    expect(await s.status()).toMatchObject({ mode: "dry-run", campaign: { campaignId: ID }, capabilities: { setRoi: true, pause: true, resume: false, create: false } });
    expect(await s.preview(OWNER, { campaignId: ID, action: "PAUSE", expectedStatus: "ENABLE", expectedRoiTenths: 35 }))
      .toEqual({ sent: false, action: "PAUSE", campaignId: ID, before: { status: "ENABLE", roiTenths: 35 }, after: { status: "DISABLE", roiTenths: 35 }, mode: "dry-run" });
    expect(store.create).not.toHaveBeenCalled();
    expect(calls.every(c => c.method === "GET")).toBe(true);
    await expect(s.preview(OWNER, { campaignId: OTHER, action: "PAUSE", expectedStatus: "ENABLE", expectedRoiTenths: 35 })).rejects.toMatchObject({ code: "CAMPAIGN_BASELINE_CHANGED" });
    const disabled = createPpanCampaignActions({ provider: fixture({ multi: true }).provider, store, mode: () => "dry-run", readPolicy: vi.fn() });
    expect((await disabled.status()).blocker).toBe("MULTIPLE_ACTIVE_CAMPAIGNS");
    const wrong = createPpanCampaignActions({ provider: fixture({ wrongIdentity: true }).provider, store, mode: () => "dry-run", readPolicy: vi.fn() });
    expect((await wrong.status()).blocker).toBe("CAMPAIGN_UNAVAILABLE");
  });

  it("uses exact documented, separated POSTs and double readback in mocked live mode", async () => {
    const h = fixture(), snap = (await h.provider.find())!;
    expect(await h.provider.send(snap, "SET_ROI", { status: "ENABLE", roiTenths: 38 }, async () => true)).toBe("APPLIED_VERIFIED");
    const fresh = (await h.provider.find())!;
    expect(await h.provider.send(fresh, "PAUSE", { status: "DISABLE", roiTenths: 38 }, async () => true)).toBe("APPLIED_VERIFIED");
    const paused = (await h.provider.find(ID))!;
    expect(await h.provider.send(paused, "RESUME", { status: "ENABLE", roiTenths: 38 }, async () => true)).toBe("APPLIED_VERIFIED");
    expect(h.calls.filter(c => c.method === "POST")).toEqual([
      { method: "POST", path: "/open_api/v1.3/campaign/gmv_max/update/", body: { advertiser_id: B.advertiserId, campaign_id: ID, roas_bid: 3.8 } },
      { method: "POST", path: "/open_api/v1.3/campaign/status/update/", body: { advertiser_id: B.advertiserId, campaign_ids: [ID], operation_status: "DISABLE" } },
      { method: "POST", path: "/open_api/v1.3/campaign/status/update/", body: { advertiser_id: B.advertiserId, campaign_ids: [ID], operation_status: "ENABLE" } },
    ]);
  });

  it("rejects revoked owner, returns known no-send when baseline moves, and never retries ambiguous write", async () => {
    const h = fixture({ unknown: true }), store = memory();
    const s = createPpanCampaignActions({ provider: h.provider, store, mode: () => "live", readPolicy: vi.fn() });
    const prep = await s.preview(OWNER, { campaignId: ID, action: "SET_ROI", expectedStatus: "ENABLE", expectedRoiTenths: 35, targetRoiTenths: 38 });
    const op = prep.operationId!;
    await expect(s.confirm(OWNER + 1, op, async () => true)).rejects.toMatchObject({ code: "CAMPAIGN_OPERATION_NOT_FOUND" });
    await expect(s.confirm(OWNER, op, async () => false)).rejects.toMatchObject({ code: "CAMPAIGN_CONFIRM_EXPIRED_OR_DISABLED" });
    h.setStatus("DISABLE");
    expect(await s.confirm(OWNER, op, async () => true)).toMatchObject({ status: "NOT_SENT", sent: false });
    expect(h.calls.some(c => c.method === "POST")).toBe(false);
    h.setStatus("ENABLE");
    const op2 = (await s.preview(OWNER, { campaignId: ID, action: "SET_ROI", expectedStatus: "ENABLE", expectedRoiTenths: 35, targetRoiTenths: 38 })).operationId!;
    expect(await s.confirm(OWNER, op2, async () => true)).toMatchObject({ status: "OUTCOME_UNKNOWN", sent: null });
    expect(await s.confirm(OWNER, op2, async () => true)).toMatchObject({ status: "OUTCOME_UNKNOWN", sent: null });
    expect(h.calls.filter(c => c.method === "POST")).toHaveLength(1);
    const mismatch = fixture({ mismatch: true });
    expect(await mismatch.provider.send((await mismatch.provider.find())!, "PAUSE", { status: "DISABLE", roiTenths: 35 }, async () => true)).toBe("OUTCOME_UNKNOWN");
  });

  it("serializes Ppan budget vs campaign writes, persists unknown, and never blocks Srihiw", async () => {
    const db = new PGlite(); dbs.push(db);
    const database = { createQueryRunner: () => ({ connect: async () => undefined, release: async () => undefined,
      query: async (sql: string, values?: unknown[]) => { if (sql.includes("CREATE TABLE")) { await db.exec(sql); return []; }
        const result = await db.query(sql, values); return sql.trimStart().startsWith("UPDATE") ? [result.rows, result.affectedRows ?? 0] : result.rows; } }) };
    const ppan = createCreatorWebBudgetStore(database), sri = createCreatorWebBudgetStore(database, "srihiw");
    await ppan.ensureSchema(); await sri.ensureSchema(); await createCreatorAutoBudgetGrantStore(database).ensureSchema();
    await createCreatorContinuousAutoBudgetStore(database).ensureSchema();
    const campaign = createPpanCampaignActionStore(database); await campaign.ensureSchema();
    const expiresAt = new Date(Date.now() + 120_000).toISOString(), op = randomUUID(), budgetOp = randomUUID(), sriOp = randomUUID();
    const plan = { operationId: op, ownerId: OWNER, campaignId: ID, action: "PAUSE" as const, before: { status: "ENABLE" as const, roiTenths: 35 },
      after: { status: "DISABLE" as const, roiTenths: 35 }, fingerprint: "a".repeat(64), expiresAt };
    const budget = { operationId: budgetOp, ownerId: OWNER, campaignId: ID, mode: "live" as const, reportingDate: "2025-02-15",
      currentBudgetMinor: 50000, targetBudgetMinor: 60000, projectedClientSpendMinor: 65000, fingerprint: "b".repeat(64), expiresAt,
      cap: { revision: 1, campaignCapMinor: 100000, clientDailyCapMinor: 100000, locked: false, readAt: new Date().toISOString() } };
    await campaign.create(plan); await ppan.create(budget); await sri.create({ ...budget, operationId: sriOp });
    expect(await ppan.reserve(OWNER, budgetOp, "live")).toMatchObject({ status: "PROCESSING" });
    expect(await campaign.reserve(OWNER, op)).toBeNull();
    await ppan.finish(OWNER, budgetOp, { status: "NOT_SENT", observedBudgetMinor: null, reason: "TEST" });
    expect(await campaign.reserve(OWNER, op)).toMatchObject({ status: "PROCESSING" });
    expect(await ppan.hasFence()).toBe(true);
    expect(await sri.hasFence()).toBe(false);
    expect(await sri.reserve(OWNER, sriOp, "live")).toMatchObject({ status: "PROCESSING" });
    await campaign.finish(OWNER, op, "OUTCOME_UNKNOWN");
    await db.query("UPDATE creator_ppan_campaign_action_operations SET expires_at=clock_timestamp()-interval '1 day' WHERE operation_id=$1", [op]);
    expect(await ppan.hasFence()).toBe(true);
    expect(await campaign.findBlocker()).toBe("WRITE_LOCKED");
  });
});
