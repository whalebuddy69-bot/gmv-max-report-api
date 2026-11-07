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
import { createAutomationRouter, parseAutomationViewerIds } from "./automation.route";

const NOW = new Date("2026-10-15T02:05:30.000Z");
const OBSERVED_AT = "2026-10-15T02:05:15.000Z";
const PERFORMANCE_OBSERVED_AT = "2026-10-15T02:03:15.000Z";
const REPORTING_DATE = "2026-10-15";
const FAKE_CAMPAIGN_ID = "9999999999999";
const PRIVATE_MARKER = "this-must-never-be-a-browser-response";
const OWNER_HEADER = { Authorization: "Bearer fixture-owner" };
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
  performance?: () => Promise<unknown>; now?: () => Date } = {}) {
  const readSnapshot = vi.fn(options.snapshot ?? (async () => observed));
  const readPerformance = vi.fn(options.performance ?? (async () => ({ state: "available", observedAt: PERFORMANCE_OBSERVED_AT, series: [
    { hour: "08:00", spendMinor: 123, gmvMinor: null, orders: 0, roi: null, liveViews: 55, secret: PRIVATE_MARKER },
    { hour: "07:00", spendMinor: null, gmvMinor: 600, orders: 3, roi: 1.5, liveViews: null },
  ] })));
  let allowlist = options.viewerIds ?? "27";
  const app = express();
  app.use("/automation", createAutomationRouter({ viewerIds: () => allowlist, readSnapshot, readPerformance,
    now: options.now ?? (() => NOW) }));
  server = await new Promise<Server>(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  const { port } = server.address() as { port: number };
  const url = `http://127.0.0.1:${port}/automation`;
  return { url, readSnapshot, readPerformance, setAllowlist: (next: string) => { allowlist = next; } };
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
      access: "verified", observedAt: OBSERVED_AT, reportingDate: REPORTING_DATE, campaign: {
        campaignId: FAKE_CAMPAIGN_ID, campaignName: campaign.campaignName, campaignStatus: "ACTIVE", dailyBudgetMinor: 123456,
        spendMinor: 23456, targetRoi: 2.5, currency: "THB",
      }, capMinor: null, actions: { start: false, pause: false, increaseBudget: false, decreaseBudget: false, auto: false },
    }] });
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
});
