import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

const auth = vi.hoisted(() => ({ verifyToken: vi.fn(), loadSessionUser: vi.fn() }));
vi.mock("../db/dataSource", () => ({ AppDataSource: {} }));
vi.mock("../services/auth.service", async importOriginal => ({
  ...await importOriginal<typeof import("../services/auth.service")>(), ...auth,
}));

import { AuthError } from "../services/auth.service";
import { CREATOR_BINDING } from "../services/creatorRead.service";
import type { AutomationCreatorReadAdapter, AutomationPerformanceScope } from "../services/creatorAutomationRegistry.service";
import { createAutomationRouter, parseAutomationViewerIds } from "./automation.route";

const NOW = new Date("2026-10-15T02:05:30.000Z");
const OBSERVED_AT = "2026-10-15T02:05:15.000Z";
const PERFORMANCE_OBSERVED_AT = "2026-10-15T02:03:15.000Z";
const REPORTING_DATE = "2026-10-15";
const FAKE_CAMPAIGN_ID = "9999999999999";
const PRIVATE_MARKER = "this-must-never-be-a-browser-response";
const OWNER_HEADER = { Authorization: "Bearer fixture-owner" };
const EXTRA = { clientId: "fixture-extra", displayName: "Creator Fixture", advertiserId: "8000000000000000003", tiktokAccountId: "7000000000000000003" };
const EXTRA_BINDING = { advertiserId: EXTRA.advertiserId, tiktokAccountId: EXTRA.tiktokAccountId,
  identityId: "fixture-extra-identity", identityType: "BC_AUTH_TT", identityAuthorizedBcId: "9000000000000000003" };
const EXTRA_CAMPAIGN = "9999999999998";
const campaign = {
  campaignId: FAKE_CAMPAIGN_ID, campaignName: "Synthetic test campaign", status: "ACTIVE", operationStatus: "ENABLE",
  dailyBudgetMinor: 123456, spendMinor: 23456, targetRoi: 2.5, currency: "THB",
  credential: PRIVATE_MARKER,
};
const observed = {
  schemaVersion: 1, clientId: "punpan_020", source: "tiktok-creator-api", timezone: "Asia/Bangkok",
  readOnly: true, binding: CREATOR_BINDING, observedAt: OBSERVED_AT, reportingDate: REPORTING_DATE,
  campaign, unverifiedPrivateData: PRIVATE_MARKER,
};

let server: Server | undefined;
beforeEach(() => {
  auth.verifyToken.mockImplementation((token: string) => {
    if (token === "fixture-owner") return { sub: 27, role: "viewer", iat: 1 };
    if (token === "fixture-admin") return { sub: 42, role: "admin", iat: 1 };
    throw new AuthError(PRIVATE_MARKER);
  });
  auth.loadSessionUser.mockImplementation(async (payload: { role: string }) => ({ role: payload.role }));
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  server = undefined;
  vi.resetAllMocks();
});

async function start(options: { viewerIds?: string; snapshot?: () => Promise<unknown>;
  performance?: () => Promise<unknown>; now?: () => Date;
  extraConfig?: string; verifiedExtras?: AutomationCreatorReadAdapter[] } = {}) {
  const readSnapshot = vi.fn(options.snapshot ?? (async () => observed));
  const readPerformance = vi.fn(options.performance ?? (async () => ({ state: "available", observedAt: PERFORMANCE_OBSERVED_AT, series: [
    { hour: "08:00", spendMinor: 123, gmvMinor: null, orders: 0, roi: null, liveViews: 55, secret: PRIVATE_MARKER },
    { hour: "07:00", spendMinor: null, gmvMinor: 600, orders: 3, roi: 1.5, liveViews: null },
  ] })));
  let allowlist = options.viewerIds ?? "27";
  const app = express();
  app.use("/automation", createAutomationRouter({ viewerIds: () => allowlist, readSnapshot, readPerformance,
    configuredExtraClients: () => options.extraConfig, verifiedExtras: () => options.verifiedExtras ?? [],
    now: options.now ?? (() => NOW) }));
  server = await new Promise<Server>(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  const { port } = server.address() as { port: number };
  const url = `http://127.0.0.1:${port}/automation`;
  return { url, readSnapshot, readPerformance, setAllowlist: (next: string) => { allowlist = next; } };
}

function extraAdapter(snapshot: unknown = { ...observed, clientId: EXTRA.clientId, binding: EXTRA_BINDING,
  campaign: { ...campaign, campaignId: EXTRA_CAMPAIGN } }) {
  return { clientId: EXTRA.clientId, binding: EXTRA_BINDING,
    readSnapshot: vi.fn(async () => snapshot),
    readPerformance: vi.fn(async (_scope: AutomationPerformanceScope) => ({ state: "available", observedAt: PERFORMANCE_OBSERVED_AT,
      series: [{ hour: "07:00", spendMinor: 50, gmvMinor: null, orders: 0, roi: null, liveViews: null }] })),
  } satisfies AutomationCreatorReadAdapter;
}

describe("private Creator Automation read routes", () => {
  it("accepts only an explicit list of positive user IDs", () => {
    expect([...parseAutomationViewerIds("27, 42")]).toEqual([27, 42]);
    for (const invalid of [undefined, "", "*", "27,", "27,42e0", "0", "27, 00042", "-42", "27,9007199254740992"])
      expect([...parseAutomationViewerIds(invalid)]).toEqual([]);
  });

  it("rejects anonymous, internal-key, forged bearer, and ungranted admins before contacting the provider", async () => {
    const h = await start();
    for (const headers of [{}, { "X-Api-Key": "fixture-owner" }, { Authorization: "Bearer forged" }]) {
      const res = await fetch(h.url + "/overview", { headers });
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).not.toContain(PRIVATE_MARKER);
    }
    const res = await fetch(h.url + "/performance", { headers: { Authorization: "Bearer fixture-admin" } });
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(h.readSnapshot).not.toHaveBeenCalled();
    expect(h.readPerformance).not.toHaveBeenCalled();
  });

  it("checks both the current report session and separate allowlist on every request", async () => {
    const h = await start();
    expect((await fetch(h.url + "/overview", { headers: OWNER_HEADER })).status).toBe(200);
    h.setAllowlist("27,");
    expect((await fetch(h.url + "/overview", { headers: OWNER_HEADER })).status).toBe(403);
    h.setAllowlist("27");
    auth.loadSessionUser.mockRejectedValueOnce(new AuthError(PRIVATE_MARKER));
    expect((await fetch(h.url + "/overview", { headers: OWNER_HEADER })).status).toBe(401);
    expect(auth.loadSessionUser).toHaveBeenCalledTimes(3);
    expect(h.readSnapshot).toHaveBeenCalledTimes(1);
  });

  it("publishes only the verified configured Creator and read-only action capabilities", async () => {
    const h = await start();
    const res = await fetch(h.url + "/overview", { headers: OWNER_HEADER });
    const body = await res.text();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).not.toContain(PRIVATE_MARKER);
    expect(body).not.toContain(CREATOR_BINDING.identityId);
    expect(JSON.parse(body)).toEqual({ schemaVersion: 1, checkedAt: NOW.toISOString(), coverage: "configured-creators-only", clients: [{
      clientId: "punpan_020", displayName: "Ppan", advertiserId: CREATOR_BINDING.advertiserId, tiktokAccountId: CREATOR_BINDING.tiktokAccountId,
      tiktokAccountIdVerified: true,
      access: "verified", observedAt: OBSERVED_AT, reportingDate: REPORTING_DATE, campaign: {
        campaignId: FAKE_CAMPAIGN_ID, campaignName: campaign.campaignName, campaignStatus: "ACTIVE", dailyBudgetMinor: 123456,
        spendMinor: 23456, targetRoi: 2.5, currency: "THB", scheduleStartAt: null, scheduleEndAt: null, viewerBoostBudgetMinor: null,
      }, capMinor: null, actions: { start: false, pause: false, increaseBudget: false, decreaseBudget: false, auto: false },
    }] });
  });

  it.each([
    ["2026-10-15T01:00:00.000Z", "2026-10-15T08:00:00.000Z", "2026-10-15T01:00:00.000Z", "2026-10-15T08:00:00.000Z"],
    ["2026-10-15T01:00:00.000Z", null, "2026-10-15T01:00:00.000Z", null],
    ["2026-10-15T01:00:00.000Z", "2026-10-14T08:00:00.000Z", null, null],
    ["2026-10-15T01:00:00.000Z", PRIVATE_MARKER, null, null],
    ["2026-02-30T01:00:00.000Z", null, null, null],
  ])("sanitizes optional display metadata without invalidating campaign observations", async (scheduleStartAt, scheduleEndAt, expectedStart, expectedEnd) => {
    const h = await start({ snapshot: async () => ({ ...observed, campaign: {
      ...campaign, scheduleStartAt, scheduleEndAt, viewerBoostBudgetMinor: 70000,
    } }) });
    const response = await (await fetch(h.url + "/overview", { headers: OWNER_HEADER })).text();
    expect(response).not.toContain(PRIVATE_MARKER);
    expect(JSON.parse(response).clients[0]).toMatchObject({ access: "verified", campaign: {
      campaignId: FAKE_CAMPAIGN_ID, scheduleStartAt: expectedStart, scheduleEndAt: expectedEnd, viewerBoostBudgetMinor: null,
    } });
  });

  it("never dispatches writes or passes caller-controlled accounts to either reader", async () => {
    const h = await start();
    for (const endpoint of ["/overview", "/performance"]) {
      const method = await fetch(h.url + endpoint, { method: "POST", headers: OWNER_HEADER });
      expect(method.status).toBe(405);
      expect(method.headers.get("allow")).toBe("GET");
      expect((await fetch(h.url + endpoint + "?advertiserId=1", { headers: OWNER_HEADER })).status).toBe(400);
      expect((await fetch(h.url + endpoint + "?reportingDate=2025-01-01", { headers: OWNER_HEADER })).status).toBe(400);
    }
    expect(h.readSnapshot).not.toHaveBeenCalled();
    expect(h.readPerformance).not.toHaveBeenCalled();
  });

  it.each([
    { ...observed, observedAt: "2026-10-15T02:04:59.000Z" },
    { ...observed, observedAt: "2026-10-15T02:06:30.000Z" },
    { ...observed, reportingDate: "2026-10-14" },
    { ...observed, binding: { ...CREATOR_BINDING, identityId: "wrong" } },
    { ...observed, campaign: { ...campaign, operationStatus: "DISABLE" } },
    { ...observed, campaign: { ...campaign, dailyBudgetMinor: 0 } },
  ])("treats stale, wrong-account, and invalid snapshots as unavailable", async invalid => {
    const h = await start({ snapshot: async () => invalid });
    const overview = await (await fetch(h.url + "/overview", { headers: OWNER_HEADER })).json();
    expect(overview.clients[0]).toMatchObject({ access: "unavailable", observedAt: null, reportingDate: null, campaign: null });
    const performance = await (await fetch(h.url + "/performance", { headers: OWNER_HEADER })).json();
    expect(performance).toMatchObject({ state: "unavailable", campaignId: null, reportingDate: null, observedAt: null, series: [] });
    expect(h.readPerformance).not.toHaveBeenCalled();
  });

  it("distinguishes an authorized account with no enabled campaign from an unavailable API", async () => {
    const h = await start({ snapshot: async () => ({ ...observed, campaign: null }) });
    const overview = await (await fetch(h.url + "/overview", { headers: OWNER_HEADER })).json();
    expect(overview.clients[0]).toMatchObject({ access: "verified", observedAt: OBSERVED_AT, campaign: null });
    const performance = await (await fetch(h.url + "/performance", { headers: OWNER_HEADER })).json();
    expect(performance).toMatchObject({ state: "no-active-campaign", campaignId: null, reportingDate: REPORTING_DATE, observedAt: null, series: [] });
    expect(h.readPerformance).not.toHaveBeenCalled();
  });

  it("returns hourly performance only for the verified current campaign and preserves null versus zero", async () => {
    const h = await start();
    const res = await fetch(h.url + "/performance", { headers: OWNER_HEADER });
    const body = await res.text();
    expect(h.readPerformance).toHaveBeenCalledWith({ campaignId: FAKE_CAMPAIGN_ID, reportingDate: REPORTING_DATE });
    expect(body).not.toContain(PRIVATE_MARKER);
    expect(JSON.parse(body)).toMatchObject({ schemaVersion: 1, checkedAt: NOW.toISOString(), clientId: "punpan_020",
      campaignId: FAKE_CAMPAIGN_ID, reportingDate: REPORTING_DATE, granularity: "hour", state: "available", observedAt: PERFORMANCE_OBSERVED_AT, series: [
        { hour: "07:00", spendMinor: null, gmvMinor: 600, orders: 3, roi: 1.5, liveViews: null },
        { hour: "08:00", spendMinor: 123, gmvMinor: null, orders: 0, roi: null, liveViews: 55 },
      ] });
  });

  it("does not echo an upstream failure or classify it as a zero-spend observation", async () => {
    const h = await start({ performance: async () => { throw new Error(PRIVATE_MARKER); } });
    const res = await fetch(h.url + "/performance", { headers: OWNER_HEADER });
    const body = await res.text();
    expect(body).not.toContain(PRIVATE_MARKER);
    expect(JSON.parse(body)).toMatchObject({ state: "unavailable", campaignId: FAKE_CAMPAIGN_ID, observedAt: null, series: [] });
  });

  it("rejects bad chart buckets instead of sending mixed scopes or estimates", async () => {
    const h = await start({ performance: async () => ({ state: "available", observedAt: PERFORMANCE_OBSERVED_AT, series: [
      { hour: "27:00", spendMinor: 900, gmvMinor: 600, orders: 3, roi: 1.5, liveViews: null },
    ] }) });
    const res = await fetch(h.url + "/performance", { headers: OWNER_HEADER });
    expect(await res.json()).toMatchObject({ state: "unavailable", observedAt: null, series: [] });
  });

  it.each([null, "2026-10-15T02:02:19.999Z", "2026-10-15T02:05:30.001Z"])("does not relabel missing, stale or future performance as fresh: %s", async observedAt => {
    const h = await start({ performance: async () => ({ state: "available", observedAt, series: [] }) });
    const res = await fetch(h.url + "/performance", { headers: OWNER_HEADER });
    expect(await res.json()).toMatchObject({ state: "unavailable", observedAt: null, series: [] });
  });

  it("lists a configured extra without claiming authorization or borrowing Ppan metrics", async () => {
    const h = await start({ extraConfig: JSON.stringify([EXTRA]) });
    const overview = await (await fetch(h.url + "/overview", { headers: OWNER_HEADER })).json();
    expect(overview.clients).toHaveLength(2);
    expect(overview.clients[0]).toMatchObject({ clientId: "punpan_020", access: "verified" });
    expect(overview.clients[1]).toEqual({ ...EXTRA, tiktokAccountIdVerified: false, access: "unavailable", accessReason: "needs-authorization", observedAt: null,
      reportingDate: null, campaign: null, capMinor: null,
      actions: { start: false, pause: false, increaseBudget: false, decreaseBudget: false, auto: false } });
    expect(await (await fetch(`${h.url}/performance/${EXTRA.clientId}`, { headers: OWNER_HEADER })).json()).toMatchObject({
      clientId: EXTRA.clientId, state: "unavailable", observedAt: null, reportingDate: null, campaignId: null, series: [],
    });
    expect(h.readSnapshot).toHaveBeenCalledTimes(1);
    expect(h.readPerformance).not.toHaveBeenCalled();
  });

  it("exposes only the requested verified adapter and retains a Ppan alias", async () => {
    const adapter = extraAdapter();
    const h = await start({ extraConfig: JSON.stringify([EXTRA]), verifiedExtras: [adapter] });
    const overview = await (await fetch(h.url + "/overview", { headers: OWNER_HEADER })).text();
    expect(overview).not.toContain(PRIVATE_MARKER);
    expect(overview).not.toContain(EXTRA_BINDING.identityId);
    expect(JSON.parse(overview).clients[1]).toMatchObject({ ...EXTRA, tiktokAccountIdVerified: false, access: "verified", campaign: { campaignId: EXTRA_CAMPAIGN } });
    const extra = await (await fetch(`${h.url}/performance/${EXTRA.clientId}`, { headers: OWNER_HEADER })).json();
    expect(extra).toMatchObject({ clientId: EXTRA.clientId, campaignId: EXTRA_CAMPAIGN, state: "available" });
    expect(adapter.readPerformance).toHaveBeenCalledTimes(1);
    expect(adapter.readPerformance).toHaveBeenCalledWith({ campaignId: EXTRA_CAMPAIGN, reportingDate: REPORTING_DATE });
    expect(h.readPerformance).not.toHaveBeenCalled();
    const ppan = await (await fetch(`${h.url}/performance/punpan_020`, { headers: OWNER_HEADER })).json();
    expect(ppan).toMatchObject({ clientId: "punpan_020", campaignId: FAKE_CAMPAIGN_ID, state: "available" });
    expect(h.readPerformance).toHaveBeenCalledTimes(1);
    expect(adapter.readSnapshot).toHaveBeenCalledTimes(2);
  });

  it("denies unauthenticated requests, caller IDs, queries and write verbs before using any Creator adapter", async () => {
    const adapter = extraAdapter();
    const h = await start({ extraConfig: JSON.stringify([EXTRA]), verifiedExtras: [adapter] });
    expect((await fetch(`${h.url}/performance/${EXTRA.clientId}`)).status).toBe(401);
    for (const value of [EXTRA.advertiserId, "not-configured", EXTRA.clientId.toUpperCase(), "bad%2Fscope"]) {
      const res = await fetch(`${h.url}/performance/${value}`, { headers: OWNER_HEADER });
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).not.toContain(EXTRA.advertiserId);
    }
    expect((await fetch(`${h.url}/performance/${EXTRA.clientId}?reportingDate=2020-01-01`, { headers: OWNER_HEADER })).status).toBe(400);
    expect((await fetch(`${h.url}/performance/${EXTRA.clientId}`, { method: "POST", headers: OWNER_HEADER })).status).toBe(405);
    expect(h.readSnapshot).not.toHaveBeenCalled();
    expect(h.readPerformance).not.toHaveBeenCalled();
    expect(adapter.readSnapshot).not.toHaveBeenCalled();
    expect(adapter.readPerformance).not.toHaveBeenCalled();
  });

  it("fails closed when a verified adapter returns another creator or an expired observation", async () => {
    const adapter = extraAdapter(observed);
    const h = await start({ extraConfig: JSON.stringify([EXTRA]), verifiedExtras: [adapter] });
    const url = `${h.url}/performance/${EXTRA.clientId}`;
    expect(await (await fetch(url, { headers: OWNER_HEADER })).json()).toMatchObject({ state: "unavailable", campaignId: null });
    const overview = await (await fetch(h.url + "/overview", { headers: OWNER_HEADER })).json();
    expect(overview.clients[1]).toMatchObject({ access: "unavailable", accessReason: "identity-unverified", campaign: null });
    adapter.readSnapshot.mockResolvedValueOnce({ ...observed, clientId: EXTRA.clientId, binding: EXTRA_BINDING, observedAt: "2026-10-15T02:00:00.000Z" });
    expect(await (await fetch(url, { headers: OWNER_HEADER })).json()).toMatchObject({ state: "unavailable", campaignId: null });
    expect(adapter.readPerformance).not.toHaveBeenCalled();
  });
});
