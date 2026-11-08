import { Router } from "express";
import { creatorReadAuthorized } from "./creatorRead.route";
import type { PpanAutoWatchState } from "../services/ppanAutoObservability.store";

/** Fixed read-only, server-to-server watchdog. Never exposes budget facts or LINE recipients. */
export function createPpanAutoWatchRouter({ enabled, key, snapshot }: {
  enabled: () => boolean; key: () => string; snapshot: () => Promise<PpanAutoWatchState>;
}) {
  const router = Router({ strict: true, caseSensitive: true });
  let windowStart = 0, requests = 0;
  router.all("/punpan_020/auto-watch", async (req, res) => {
    res.set("Cache-Control", "no-store").set("X-Content-Type-Options", "nosniff");
    const reject = (status: number, code: string) => res.status(status).json({ error: { code } });
    if (!enabled() || key().length < 32) return reject(503, "CREATOR_READ_DISABLED");
    if (!creatorReadAuthorized(req.headers["x-creator-read-key"], key())) return reject(401, "UNAUTHORIZED");
    if (req.method !== "GET") { res.set("Allow", "GET"); return reject(405, "READ_ONLY"); }
    if (req.originalUrl.includes("?") || req.headers["transfer-encoding"] !== undefined || Number(req.headers["content-length"] ?? 0) !== 0 ||
        req.headers.origin !== undefined || req.headers.cookie !== undefined || req.headers.referer !== undefined ||
        req.headers["sec-fetch-site"] !== undefined || req.headers["sec-fetch-dest"] !== undefined) return reject(400, "FIXED_CREATOR_SCOPE");
    const at = Date.now();
    if (at - windowStart >= 60_000) { windowStart = at; requests = 0; }
    if (++requests > 20) return reject(429, "RATE_LIMITED");
    try {
      const state = await snapshot();
      const incident = state.incident ? { sessionId: state.incident.sessionId, kind: state.incident.kind, incidentKey: state.incident.incidentKey } : null;
      return res.json({ schemaVersion: 1, clientId: "punpan_020", armState: state.armState, sessionId: state.sessionId, incident });
    } catch { return reject(503, "AUTO_WATCH_UNAVAILABLE"); }
  });
  return router;
}
