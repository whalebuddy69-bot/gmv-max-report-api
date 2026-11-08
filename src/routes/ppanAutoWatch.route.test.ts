import { randomUUID } from "node:crypto";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { createPpanAutoWatchRouter } from "./ppanAutoWatch.route";

vi.mock("../db/dataSource", () => ({ AppDataSource: {} }));

describe("Ppan Auto watcher route", () => {
  it("is read-only, private and fixed to Ppan; serializes only the minimized incident view", async () => {
    const key = "a".repeat(43), sessionId = randomUUID(), incidentKey = randomUUID();
    const incident = { sessionId, kind: "OUTCOME_UNKNOWN" as const, incidentKey, token: "must not leave service" };
    const snapshot = vi.fn(async () => ({ armState: "ACTIVE" as const, sessionId, incident, raw: "must not leave service" }));
    const app = express();
    app.use("/internal/creator", createPpanAutoWatchRouter({ enabled: () => true, key: () => key, snapshot }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing fixture address");
      const root = `http://127.0.0.1:${address.port}/internal/creator`;
      const headers = { "x-creator-read-key": key };
      expect((await fetch(`${root}/punpan_020/auto-watch`)).status).toBe(401);
      expect((await fetch(`${root}/srihiw/auto-watch`, { headers })).status).toBe(404);
      expect((await fetch(`${root}/punpan_020/auto-watch?scope=other`, { headers })).status).toBe(400);
      expect((await fetch(`${root}/punpan_020/auto-watch`, { method: "POST", headers })).status).toBe(405);
      expect((await fetch(`${root}/punpan_020/auto-watch`, { headers: { ...headers, origin: "https://example.com" } })).status).toBe(400);
      expect(snapshot).not.toHaveBeenCalled();
      const response = await fetch(`${root}/punpan_020/auto-watch`, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ schemaVersion: 1, clientId: "punpan_020", armState: "ACTIVE", sessionId,
        incident: { sessionId, kind: "OUTCOME_UNKNOWN", incidentKey } });
      expect(snapshot).toHaveBeenCalledTimes(1);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
