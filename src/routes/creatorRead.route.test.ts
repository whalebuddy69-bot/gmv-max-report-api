import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

const mocks = vi.hoisted(() => ({ runner: { connect: vi.fn(), query: vi.fn(), release: vi.fn() }, decrypt: vi.fn(() => "runtime-token-private") }));
vi.mock("../db/dataSource", () => ({ AppDataSource: { createQueryRunner: () => mocks.runner } }));
vi.mock("../utils/crypto", () => ({ decryptSecret: mocks.decrypt }));
vi.mock("../config", () => ({ config: { tiktokOAuth: { appId: "7667234745498992657" } } }));
import { createCreatorReadRouter, createExtraCreatorTokenLoader, creatorReadAuthorized, loadCreatorToken } from "./creatorRead.route";

const KEY = "bridge-key-canary-01234567890123456789";
let server: Server | undefined;
afterEach(async () => { if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); server = undefined; vi.clearAllMocks(); });
async function start(options: { enabled?: boolean; key?: string; snapshot?: () => Promise<unknown> } = {}) {
  const app = express(), snapshot = vi.fn(options.snapshot ?? (async () => ({ readOnly: true, clientId: "punpan_020" })));
  app.use("/internal/creator", createCreatorReadRouter({ enabled: () => options.enabled !== false, key: () => options.key ?? KEY, snapshot }));
  server = await new Promise<Server>(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}/internal/creator/punpan_020/snapshot`, snapshot };
}
describe("dedicated Creator read endpoint", () => {
  it("fails closed when disabled or key is absent", async () => {
    expect(creatorReadAuthorized("", "")).toBe(false); expect(creatorReadAuthorized(KEY, KEY)).toBe(true);
    const h = await start({ key: "" }); expect((await fetch(h.url)).status).toBe(503); expect(h.snapshot).not.toHaveBeenCalled();
  });
  it("requires the dedicated key, not a report JWT or internal bearer", async () => {
    const h = await start();
    for (const headers of [{}, { Authorization: `Bearer ${KEY}` }, { "X-Creator-Read-Key": "wrong" }]) expect((await fetch(h.url, { headers })).status).toBe(401);
    expect(h.snapshot).not.toHaveBeenCalled();
    const response = await fetch(h.url, { headers: { "X-Creator-Read-Key": KEY } });
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ readOnly: true, clientId: "punpan_020" });
  });
  it("rejects mutation methods and arbitrary account query parameters", async () => {
    const h = await start(), headers = { "X-Creator-Read-Key": KEY };
    expect((await fetch(h.url, { method: "POST", headers })).status).toBe(405);
    expect((await fetch(h.url + "?advertiser_id=other", { headers })).status).toBe(400);
    expect(h.snapshot).not.toHaveBeenCalled();
  });
  it("does not expose upstream errors or credentials", async () => {
    const h = await start({ snapshot: async () => { throw new Error(KEY + " secret token"); } });
    const response = await fetch(h.url, { headers: { "X-Creator-Read-Key": KEY } });
    expect(response.status).toBe(502); expect(await response.text()).not.toContain(KEY);
  });
  it("uses a bounded read-only DB transaction and releases before decrypting", async () => {
    const events: string[] = [];
    mocks.runner.query.mockImplementation(async (sql: string, params?: string[]) => {
      events.push(sql);
      if (sql === "SHOW transaction_read_only") return [{ transaction_read_only: "on" }];
      if (sql.startsWith("SELECT")) { expect(params).toEqual(["7666005333864644624"]); return [{ access_token: "encrypted-private", authorized_at_db: "2026-10-07" }]; }
      return [];
    });
    mocks.runner.release.mockImplementation(async () => { events.push("RELEASE"); });
    mocks.decrypt.mockImplementation(() => { expect(events.at(-1)).toBe("RELEASE"); return "runtime-token-private"; });
    expect(await loadCreatorToken()).toBe("runtime-token-private");
    expect(events[0]).toBe("BEGIN READ ONLY"); expect(events).toContain("ROLLBACK");
    expect(events.some(x => /INSERT|UPDATE|DELETE/.test(x))).toBe(false);
  });

  it("only reads the server-configured extra advertiser row and fails on ambiguous authorization", async () => {
    const advertiser = "9123456789012345678";
    expect(() => createExtraCreatorTokenLoader("bad/advertiser")).toThrow();
    expect(() => createExtraCreatorTokenLoader("7666005333864644624")).toThrow();
    mocks.runner.query.mockImplementation(async (sql: string, params?: string[]) => {
      if (sql === "SHOW transaction_read_only") return [{ transaction_read_only: "on" }];
      if (sql.startsWith("SELECT")) {
        expect(params).toEqual([advertiser]);
        return [{ access_token: "ciphertext-a", authorized_at_db: "2026-11-07" }, { access_token: "ciphertext-b", authorized_at_db: "2026-11-07" }];
      }
      return [];
    });
    await expect(createExtraCreatorTokenLoader(advertiser)()).rejects.toMatchObject({ code: "CREATOR_CREDENTIAL_UNAVAILABLE" });
    expect(mocks.decrypt).not.toHaveBeenCalled();
    expect(mocks.runner.query).toHaveBeenCalledWith("ROLLBACK");
  });
});
