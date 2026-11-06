import crypto from "node:crypto";
import { Router } from "express";
import { CreatorBudgetTestError, CreatorBudgetTestService } from "../services/creatorBudgetTest.service";

/** Report auth and the read bridge key intentionally cannot authorize a mutation. */
export function creatorBudgetTestAuthorized(supplied: unknown, expected: string, readKey: string): boolean {
  if (typeof supplied !== "string" || expected.length < 43 || expected === readKey) return false;
  return crypto.timingSafeEqual(crypto.createHash("sha256").update(supplied).digest(), crypto.createHash("sha256").update(expected).digest());
}
export function createCreatorBudgetTestRouter(options: { key: () => string; readKey: () => string; service: CreatorBudgetTestService }) {
  const router = Router();
  let windowStart = 0, requests = 0;
  router.use("/punpan_020/budget-test", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const key = options.key(), readKey = options.readKey();
    if (key.length < 43 || key === readKey) { res.status(503).json({ error: { code: "BUDGET_TEST_KEY_UNAVAILABLE" } }); return; }
    if (!creatorBudgetTestAuthorized(req.headers["x-creator-budget-test-key"], key, readKey)) {
      res.status(401).json({ error: { code: "UNAUTHORIZED" } }); return;
    }
    if (Object.keys(req.query).length) { res.status(400).json({ error: { code: "FIXED_TEST_SCOPE_REQUIRED" } }); return; }
    if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); requests = 0; }
    if (++requests > 20) { res.status(429).json({ error: { code: "RATE_LIMITED" } }); return; }
    next();
  });
  function wrap(action: (req: any) => unknown | Promise<unknown>) {
    return async (req: any, res: any) => {
      try { res.json(await action(req)); }
      catch (error) {
        const known = error instanceof CreatorBudgetTestError;
        const code = known ? error.code : "BUDGET_TEST_UNAVAILABLE";
        // Never label an unavailable ledger as proof that no provider request happened.
        const noSend = known && error.provenNoSend;
        const permitId = typeof req.body?.permitId === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(req.body.permitId)
          ? req.body.permitId : req.params.permitId ?? null;
        res.status(known ? error.httpStatus : 503).json({ ok: false, permitId,
          status: noSend ? "REJECTED" : "UNAVAILABLE", postCount: noSend ? 0 : null,
          writeAttempted: noSend ? false : null, providerAccepted: null, observedBudgetMinor: null,
          reason: code, lockSafeToRelease: noSend, error: { code } });
      }
    };
  }
  // Metadata is protected but performs NO provider or database reads, including while OFF.
  router.get("/punpan_020/budget-test/status", wrap(() => options.service.metadata()));
  router.post("/punpan_020/budget-test", wrap(req => options.service.execute(req.body)));
  router.get("/punpan_020/budget-test/:permitId", wrap(req => options.service.status(req.params.permitId)));
  router.post("/punpan_020/budget-test/:permitId/reconcile", wrap(req => {
    if (req.body != null && (typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length)) {
      throw new CreatorBudgetTestError("RECONCILIATION_BODY_NOT_ALLOWED", 400);
    }
    return options.service.reconcile(req.params.permitId);
  }));
  router.all(["/punpan_020/budget-test", "/punpan_020/budget-test/status", "/punpan_020/budget-test/:permitId", "/punpan_020/budget-test/:permitId/reconcile"], (_req, res) => {
    res.status(405).json({ error: { code: "METHOD_NOT_ALLOWED" } });
  });
  return router;
}
