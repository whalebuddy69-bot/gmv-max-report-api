import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { creatorBudgetTestAuthorized, createCreatorBudgetTestRouter } from "./creatorBudgetTest.route";
import { CreatorBudgetTestError } from "../services/creatorBudgetTest.service";

const KEY = "writer-canary-unique-key-012345678901234567890123456789", READ = "reader-canary-012345678901234567890123456789";
const PERMIT = "ppan-one-shot-20261108";
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  server = undefined;
});
async function start(options: Record<string, any> = {}) {
  const app = express(); app.use(express.json());
  const service = { metadata: vi.fn(() => ({ enabled: false, configured: false, canWriteNow: false })),
    initialize: vi.fn(), execute: vi.fn(options.execute ?? (async () => ({ status: "WAIT" }))),
    status: vi.fn(async () => ({ status: "OUTCOME_UNKNOWN" })), reconcile: vi.fn(async () => ({ status: "OUTCOME_UNKNOWN" })) };
  app.use("/internal/creator", createCreatorBudgetTestRouter({ key: () => options.key ?? KEY,
    readKey: () => options.readKey ?? READ, service }));
  server = await new Promise<Server>(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}/internal/creator/punpan_020/budget-test`, service };
}
describe("dedicated budget-test authorization and routes", () => {
  it("rejects missing/short/reused read keys before calling any service", async () => {
    expect(creatorBudgetTestAuthorized(KEY, KEY, READ)).toBe(true);
    expect(creatorBudgetTestAuthorized(KEY, KEY, KEY)).toBe(false);
    const h = await start({ key: READ, readKey: READ });
    expect((await fetch(h.base + "/status", { headers: { "X-Creator-Budget-Test-Key": READ } })).status).toBe(503);
    expect(h.service.metadata).not.toHaveBeenCalled();
  });
  it("the read bridge key or report bearer never authorizes the writer", async () => {
    const h = await start();
    for (const headers of [{}, { "X-Creator-Read-Key": READ }, { "X-Creator-Budget-Test-Key": READ }, { Authorization: `Bearer ${KEY}` }]) {
      expect((await fetch(h.base + "/status", { headers })).status).toBe(401);
    }
    expect(h.service.metadata).not.toHaveBeenCalled(); expect(h.service.execute).not.toHaveBeenCalled();
  });
  it("metadata works while OFF without provider/DB/initialize calls and precedes the permit route", async () => {
    const h = await start(), response = await fetch(h.base + "/status", { headers: { "X-Creator-Budget-Test-Key": KEY } });
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ enabled: false, configured: false, canWriteNow: false });
    expect(h.service.status).not.toHaveBeenCalled(); expect(h.service.initialize).not.toHaveBeenCalled();
  });
  it("disabled mutation returns a redacted, explicit no-send envelope", async () => {
    const h = await start({ execute: async () => { throw new CreatorBudgetTestError("BUDGET_TEST_DISABLED", 503, true); } });
    const response = await fetch(h.base, { method: "POST", headers: { "Content-Type": "application/json", "X-Creator-Budget-Test-Key": KEY }, body: JSON.stringify({ permitId: PERMIT }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ permitId: PERMIT, status: "REJECTED", postCount: 0, writeAttempted: false,
      providerAccepted: null, observedBudgetMinor: null, lockSafeToRelease: true, reason: "BUDGET_TEST_DISABLED" });
  });
  it("does not turn an unavailable ledger into evidence of no attempted POST", async () => {
    const h = await start({ execute: async () => { throw new Error(KEY + " raw database/URL/token"); } });
    const response = await fetch(h.base, { method: "POST", headers: { "Content-Type": "application/json", "X-Creator-Budget-Test-Key": KEY }, body: JSON.stringify({ permitId: PERMIT }) });
    expect(response.status).toBe(503); const body = await response.json() as any;
    expect(body).toMatchObject({ status: "UNAVAILABLE", postCount: null, writeAttempted: null, lockSafeToRelease: false });
    expect(JSON.stringify(body)).not.toContain(KEY);
  });
  it("allows GET status/read-only reconciliation but not arbitrary request scope or methods", async () => {
    const h = await start(), headers = { "X-Creator-Budget-Test-Key": KEY, "Content-Type": "application/json" };
    expect((await fetch(h.base + "/" + PERMIT, { headers })).status).toBe(200);
    expect((await fetch(h.base + "/" + PERMIT + "/reconcile", { method: "POST", headers, body: "{}" })).status).toBe(200);
    expect(h.service.reconcile).toHaveBeenCalledWith(PERMIT);
    expect((await fetch(h.base + "/" + PERMIT + "/reconcile", { method: "POST", headers, body: '{"roi":2}' })).status).toBe(400);
    expect((await fetch(h.base + "?advertiserId=other", { method: "POST", headers })).status).toBe(400);
    expect((await fetch(h.base, { method: "PUT", headers })).status).toBe(405);
  });
});
