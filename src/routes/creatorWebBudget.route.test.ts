import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

const auth = vi.hoisted(() => ({ verifyToken: vi.fn(), loadSessionUser: vi.fn() }));
vi.mock("../db/dataSource", () => ({ AppDataSource: {} }));
vi.mock("../services/auth.service", async importOriginal => ({
  ...await importOriginal<typeof import("../services/auth.service")>(), ...auth,
}));
import { AuthError } from "../services/auth.service";
import { createCreatorWebBudgetService } from "../services/creatorWebBudget.service";
import { CREATOR_WEB_BUDGET_ORIGIN, createCreatorWebBudgetRouter } from "./creatorWebBudget.route";

const PRIVATE_ERROR = "test-secret-that-must-not-leak";
const ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const PREPARE = { expectedCampaignId: "90000000000001", expectedBudgetMinor: 120000, targetBudgetMinor: 150000 };
const CONFIRM = { operationId: ID, nativeAutoOff: true, noConcurrentChanges: true };
const HEADERS = { Authorization: "Bearer operator", Origin: CREATOR_WEB_BUDGET_ORIGIN, "Content-Type": "application/json" };
let server: Server | undefined;
beforeEach(() => {
  auth.verifyToken.mockImplementation((token: string) => {
    if (token === "operator") return { sub: 27, role: "viewer", iat: 1 };
    if (token === "report-admin") return { sub: 42, role: "admin", iat: 1 };
    throw new AuthError(PRIVATE_ERROR);
  });
  auth.loadSessionUser.mockImplementation(async (payload: { role: string }) => ({ role: payload.role }));
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  server = undefined;
  vi.resetAllMocks();
});

async function start({ viewerIds = "27,42", operatorIds = "27", extraCapConfigured = true } = {}) {
  const service: ReturnType<typeof createCreatorWebBudgetService> = {
    status: vi.fn(async operator => ({ clientId: "punpan_020", mode: operator ? "dry-run" : "disabled", cap: null, canPrepare: false, capEditAllowed: false })),
    prepare: vi.fn(async (_id, value) => ({ operationId: ID, mode: "dry-run", campaignId: value.expectedCampaignId,
      currentBudgetMinor: value.expectedBudgetMinor, targetBudgetMinor: value.targetBudgetMinor, projectedClientSpendMinor: 240000,
      cap: { campaignCapMinor: 600000, clientDailyCapMinor: 800000, revision: 3, locked: false, readAt: "2026-06-09T04:00:00.000Z" },
      expiresAt: "2026-06-09T04:02:00.000Z" })),
    confirm: vi.fn(async (_id, value, recheck) => ({ operationId: value.operationId, observedBudgetMinor: null,
      status: await recheck() ? "SIMULATED" : "NOT_SENT" })),
    operation: vi.fn(async (_id, operationId) => ({ operationId, status: "NOT_SENT", observedBudgetMinor: null })),
  };
  const capEditor = {
    status: vi.fn(async (_client: "punpan_020" | "srihiw") => ({ cap: null, capEditAllowed: true })),
    update: vi.fn(async (_client: "punpan_020" | "srihiw", _id: number, revision: number, capMinor: number, recheck: () => Promise<boolean>) => {
      if (!await recheck()) throw new AuthError(PRIVATE_ERROR);
      return { revision: revision + 1, capMinor };
    }),
  };
  const srihiwService: typeof service = { ...service,
    status: vi.fn(async operator => ({ clientId: "srihiw", mode: operator ? "live" : "disabled", cap: null, canPrepare: false, capEditAllowed: false })),
    prepare: vi.fn(vi.mocked(service.prepare).getMockImplementation()), confirm: vi.fn(vi.mocked(service.confirm).getMockImplementation()),
    operation: vi.fn(async (_id, operationId) => ({ operationId, status: "NOT_SENT", observedBudgetMinor: null })),
  };
  const app = express();
  app.use("/automation/budget", createCreatorWebBudgetRouter({ viewerIds: () => viewerIds, operatorIds: () => operatorIds, service,
    srihiwService, capEditor, extraCapConfigured: () => extraCapConfigured }));
  // Prove this route does not run the general application parser first.
  app.use(express.json());
  server = await new Promise<Server>(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}/automation/budget`;
  const post = (route: string, body = JSON.stringify(PREPARE), headers = HEADERS) => fetch(base + route, { method: "POST", headers, body });
  return { service, srihiwService, base, post, capEditor };
}

describe("Automation web budget HTTP boundary", () => {
  it("uses authenticated viewer access for cap status, no-store even for an anonymous request", async () => {
    const h = await start();
    const missing = await fetch(h.base + "/status");
    expect(missing.status).toBe(401); expect(missing.headers.get("cache-control")).toBe("no-store");
    const read = await fetch(h.base + "/status", { headers: { Authorization: "Bearer report-admin" } });
    expect(read.status).toBe(200); expect(await read.json()).toMatchObject({ mode: "disabled" });
    expect(h.service.status).toHaveBeenCalledWith(false);
  });

  it.each(["27,", "42", ""]) ("requires operator and viewer grant (operator allowlist %j)", async operatorIds => {
    const h = await start({ operatorIds });
    expect((await h.post("/prepare")).status).toBe(403);
    expect(h.service.prepare).not.toHaveBeenCalled();
  });

  it("rejects internal key and untrusted/missing Origin before proposal handling", async () => {
    const h = await start();
    expect((await h.post("/prepare", JSON.stringify(PREPARE), { ...HEADERS, Authorization: "", "X-Api-Key": "operator" } as typeof HEADERS)).status).toBe(401);
    expect((await h.post("/prepare", JSON.stringify(PREPARE), { ...HEADERS, Origin: "https://report.whalebuddy69.com.attacker.test" })).status).toBe(403);
    expect((await h.post("/prepare", JSON.stringify(PREPARE), { ...HEADERS, Origin: "" })).status).toBe(403);
    expect(h.service.prepare).not.toHaveBeenCalled();
  });

  it("uses separate exact scope and operator identity for cap updates, never the TikTok writer", async () => {
    const h = await start();
    const r = await fetch(h.base + "/cap/srihiw", { headers: { Authorization: "Bearer report-admin" } });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ clientId: "srihiw", cap: null, capEditAllowed: false });
    const input = JSON.stringify({ expectedRevision: 0, capMinor: 450000 });
    expect((await h.post("/cap", input)).status).toBe(400);
    expect((await h.post("/cap/other", input)).status).toBe(404);
    expect((await h.post("/cap/srihiw", input, { ...HEADERS, Authorization: "Bearer report-admin" })).status).toBe(403);
    expect((await h.post("/cap/srihiw", input, { ...HEADERS, Origin: "https://evil.example" })).status).toBe(403);
    expect((await h.post("/cap/srihiw", JSON.stringify({ expectedRevision: 0, capMinor: 450000, actorUserId: 42 }))).status).toBe(400);
    expect(await (await h.post("/cap/srihiw", input)).json()).toEqual({ revision: 1, capMinor: 450000 });
    expect(h.capEditor.update).toHaveBeenCalledTimes(1);
    expect(h.capEditor.update).toHaveBeenCalledWith("srihiw", 27, 0, 450000, expect.any(Function));
    expect(h.service.confirm).not.toHaveBeenCalled();
  });

  it("rejects Srihiw cap lookup/update if the verified registry did not configure this Creator", async () => {
    const h = await start({ extraCapConfigured: false });
    expect((await fetch(h.base + "/cap/srihiw", { headers: HEADERS })).status).toBe(404);
    expect((await h.post("/cap/srihiw", JSON.stringify({ expectedRevision: 0, capMinor: 450000 }))).status).toBe(404);
    expect(h.capEditor.status).not.toHaveBeenCalled();
    expect(h.capEditor.update).not.toHaveBeenCalled();
    expect((await h.post("/srihiw/confirm", JSON.stringify(CONFIRM))).status).toBe(404);
    expect(h.srihiwService.confirm).not.toHaveBeenCalled();
    expect(h.service.confirm).not.toHaveBeenCalled();
  });

  it("routes Srihiw operation recovery, preparation and confirmation only to Srihiw's service", async () => {
    const h = await start();
    const s = await fetch(h.base + "/srihiw/status", { headers: HEADERS });
    expect(await s.json()).toMatchObject({ clientId: "srihiw", mode: "live", canPrepare: false });
    expect((await fetch(h.base + "/srihiw/operations/" + ID, { headers: HEADERS })).status).toBe(200);
    expect((await h.post("/srihiw/prepare")).status).toBe(200);
    expect((await h.post("/srihiw/confirm", JSON.stringify(CONFIRM))).status).toBe(200);
    expect(h.srihiwService.operation).toHaveBeenCalledWith(27, ID);
    expect(h.srihiwService.prepare).toHaveBeenCalledWith(27, PREPARE);
    expect(h.srihiwService.confirm).toHaveBeenCalledWith(27, CONFIRM, expect.any(Function));
    for (const route of ["/Srihiw/confirm", "/other/confirm", "/%73rihiw/confirm"]) {
      expect((await h.post(route, JSON.stringify(CONFIRM))).status).toBe(404);
    }
    expect(h.service.status).not.toHaveBeenCalled(); expect(h.service.operation).not.toHaveBeenCalled();
    expect(h.service.prepare).not.toHaveBeenCalled(); expect(h.service.confirm).not.toHaveBeenCalled();
  });

  it("rejects malformed, non-JSON, oversized, unknown fields and caller-controlled query", async () => {
    const h = await start();
    expect((await h.post("/prepare", "{malformed")).status).toBe(400);
    expect((await h.post("/prepare", "{}", { ...HEADERS, "Content-Type": "text/plain" })).status).toBe(415);
    expect((await h.post("/prepare", JSON.stringify({ extra: "x".repeat(3000) }))).status).toBe(413);
    expect((await h.post("/prepare", JSON.stringify({ ...PREPARE, advertiserId: "arbitrary" }))).status).toBe(400);
    expect((await h.post("/prepare?campaignId=arbitrary")).status).toBe(400);
    expect((await h.post("/confirm", JSON.stringify({ ...CONFIRM, nativeAutoOff: false }))).status).toBe(400);
    expect(h.service.prepare).not.toHaveBeenCalled(); expect(h.service.confirm).not.toHaveBeenCalled();
  });

  it("passes only validated fields and verifies the operator's session again at dispatch", async () => {
    const h = await start();
    const p = await h.post("/prepare");
    expect(p.status).toBe(200); expect(h.service.prepare).toHaveBeenCalledWith(27, PREPARE);
    auth.loadSessionUser.mockResolvedValueOnce({ role: "viewer" }).mockRejectedValueOnce(new AuthError(PRIVATE_ERROR));
    const c = await h.post("/confirm", JSON.stringify(CONFIRM));
    expect(await c.json()).toMatchObject({ status: "NOT_SENT" });
    expect(h.service.confirm).toHaveBeenCalledWith(27, CONFIRM, expect.any(Function));
  });

  it("sanitizes server errors, protects operation reads, and bounds requests", async () => {
    const h = await start();
    const privateRead = await fetch(h.base + "/operations/" + ID, { headers: { Authorization: "Bearer report-admin" } });
    expect(privateRead.status).toBe(403); expect(h.service.operation).not.toHaveBeenCalled();
    vi.mocked(h.service.prepare).mockRejectedValueOnce(new Error(PRIVATE_ERROR));
    const bad = await h.post("/prepare"); expect(bad.status).toBe(503); expect(await bad.text()).not.toContain(PRIVATE_ERROR);
    for (let i = 0; i < 11; i++) expect((await h.post("/prepare")).status).toBe(200);
    const limited = await h.post("/prepare"); expect(limited.status).toBe(429);
    expect(h.service.prepare).toHaveBeenCalledTimes(12);
  });
});
