import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createPpanCampaignActionsRouter } from "./creatorCampaignActions.route";
import type { createPpanCampaignActions } from "../services/creatorCampaignActions.service";
import { AppError } from "../utils/errors";

vi.mock("../db/dataSource", () => ({ AppDataSource: {} }));
vi.mock("../middleware/auth", () => ({ requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
  const value = req.header("authorization");
  if (value === "Bearer signed") { req.user = { sub: 27, role: "admin", email: "test@example.test" }; next(); return; }
  if (value === "Bearer non-admin") { req.user = { sub: 27, role: "viewer", email: "test@example.test" }; next(); return; }
  next(new AppError("bad", "AUTH_FAILED", 401));
} }));
vi.mock("../services/auth.service", () => ({ verifyToken: () => ({ sub: 27 }), loadSessionUser: async () => ({ role: "admin" }) }));

const ID = "91900000000001", OP = "11111111-1111-4111-8111-111111111111";
const servers: Array<ReturnType<express.Express["listen"]>> = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>(resolve => s.close(() => resolve())); });
async function fixture() {
  const service = { status: vi.fn(async () => ({ mode: "dry-run" })), preview: vi.fn(async () => ({ sent: false })),
    operation: vi.fn(async () => ({ status: "PREPARED" })), confirm: vi.fn(async (_owner: number, _id: string, authorize: () => Promise<boolean>) => ({ authorized: await authorize() })) };
  const app = express();
  app.use("/automation/campaign", createPpanCampaignActionsRouter({ service: service as unknown as ReturnType<typeof createPpanCampaignActions>, viewerIds: () => "27", operatorIds: () => "27" }));
  const server = app.listen(0, "127.0.0.1"); servers.push(server); await once(server, "listening");
  const a = server.address(); if (!a || typeof a === "string") throw Error("listen failed");
  return { service, url: `http://127.0.0.1:${a.port}/automation/campaign` };
}
const auth = { Authorization: "Bearer signed" };
const headers = { ...auth, Origin: "https://report.whalebuddy69.com", "Content-Type": "application/json" };
const payload = { action: "SET_ROI", campaignId: ID, expectedStatus: "ENABLE", expectedRoiTenths: 35, targetRoiTenths: 38 };

describe("Creator campaign controls HTTP boundary", () => {
  it("requires allowed admin, fixed scope, exact host and strict action fields", async () => {
    const h = await fixture();
    expect((await fetch(h.url + "/status")).status).toBe(401);
    expect((await fetch(h.url + "/status", { headers: { Authorization: "Bearer non-admin" } })).status).toBe(403);
    const ok = await fetch(h.url + "/status", { headers: auth });
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.status).toBe(200);
    expect((await fetch(h.url + "/status?client=srihiw", { headers: auth })).status).toBe(400);
    const post = (path: string, body: unknown, hds = headers) => fetch(h.url + path, { method: "POST", headers: hds, body: JSON.stringify(body) });
    expect((await post("/preview", payload, { ...headers, Origin: "https://wrong.test" })).status).toBe(403);
    expect((await post("/preview", { ...payload, clientId: "srihiw" })).status).toBe(400);
    expect((await post("/preview", { ...payload, action: "PAUSE" })).status).toBe(400);
    expect((await post("/preview", { ...payload, targetRoiTenths: 4.1 })).status).toBe(400);
    expect((await post("/preview", { ...payload, action: "CREATE" })).status).toBe(400);
    expect((await post("/preview", payload)).status).toBe(200);
    expect(h.service.preview).toHaveBeenCalledWith(27, payload);
    expect(h.service.preview).toHaveBeenCalledTimes(1);
    expect((await post("/confirm", { operationId: OP, confirmed: false })).status).toBe(400);
    const r = await post("/confirm", { operationId: OP, confirmed: true });
    expect(await r.json()).toEqual({ authorized: true });
  });

  it("authorizes only a numeric exact campaign status path and never treats GET as a command", async () => {
    const h = await fixture();
    expect((await fetch(`${h.url}/status/${ID}`)).status).toBe(401);
    expect((await fetch(`${h.url}/status/${ID}`, { headers: { Authorization: "Bearer non-admin" } })).status).toBe(403);
    expect((await fetch(`${h.url}/status/${ID}?client=srihiw`, { headers: auth })).status).toBe(400);
    expect((await fetch(`${h.url}/status/not-a-campaign`, { headers: auth })).status).toBe(400);
    expect((await fetch(`${h.url}/status/${ID}`, { headers: auth })).status).toBe(200);
    expect(h.service.status).toHaveBeenCalledTimes(1);
    expect(h.service.status).toHaveBeenCalledWith(ID);
    expect(h.service.preview).not.toHaveBeenCalled();
    expect(h.service.confirm).not.toHaveBeenCalled();
  });
});
