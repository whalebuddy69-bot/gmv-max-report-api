import crypto from "node:crypto";
import { Router } from "express";
import { config } from "../config";
import { AppDataSource } from "../db/dataSource";
import { decryptSecret } from "../utils/crypto";
import { CREATOR_APP_ID, CREATOR_BINDING, CreatorReadError, createCreatorReader } from "../services/creatorRead.service";

/** Separate key: existing report JWTs/internal keys cannot access this pilot route. */
export function creatorReadAuthorized(supplied: unknown, expected: string): boolean {
  if (expected.length < 32 || typeof supplied !== "string") return false;
  return crypto.timingSafeEqual(crypto.createHash("sha256").update(supplied).digest(), crypto.createHash("sha256").update(expected).digest());
}
export function loadCreatorToken(): Promise<string> {
  return loadCreatorTokenForExactAdvertiser(CREATOR_BINDING.advertiserId);
}

/** Only called with an immutable server-configured advertiser, never a request input. */
export function createExtraCreatorTokenLoader(advertiserId: string): () => Promise<string> {
  if (typeof advertiserId !== "string" || !/^[1-9]\d{5,30}$/.test(advertiserId) || advertiserId === CREATOR_BINDING.advertiserId) {
    throw new CreatorReadError("CREATOR_EXTRA_ADVERTISER_UNVERIFIED");
  }
  return () => loadCreatorTokenForExactAdvertiser(advertiserId);
}

async function loadCreatorTokenForExactAdvertiser(advertiserId: string): Promise<string> {
  if (config.tiktokOAuth.appId !== CREATOR_APP_ID) throw new CreatorReadError("APP_BINDING_UNVERIFIED");
  const runner = AppDataSource.createQueryRunner();
  let encrypted: string | undefined, failure = false;
  try {
    await runner.connect();
    await runner.query("BEGIN READ ONLY");
    await runner.query("SET LOCAL statement_timeout = '5s'");
    const readOnly = await runner.query("SHOW transaction_read_only");
    if (readOnly[0]?.transaction_read_only !== "on") throw new CreatorReadError("DATABASE_READ_ONLY_UNVERIFIED");
    const rows = await runner.query("SELECT access_token, authorized_at::text AS authorized_at_db FROM oauth_tokens WHERE advertiser_id = $1 AND revoked_at IS NULL ORDER BY authorized_at DESC NULLS LAST, id DESC LIMIT 2", [advertiserId]);
    if (!rows.length || typeof rows[0].access_token !== "string" || !rows[0].authorized_at_db
      || (rows.length > 1 && rows[0].authorized_at_db === rows[1].authorized_at_db)) throw new CreatorReadError("CREDENTIAL_SELECTION_UNVERIFIED");
    encrypted = rows[0].access_token;
  } catch { failure = true; }
  finally {
    try { await runner.query("ROLLBACK"); } catch { failure = true; }
    try { await runner.release(); } catch { failure = true; }
  }
  if (failure || !encrypted) throw new CreatorReadError("CREATOR_CREDENTIAL_UNAVAILABLE");
  try { return decryptSecret(encrypted); } catch { throw new CreatorReadError("CREATOR_CREDENTIAL_UNAVAILABLE"); }
}
export function createCreatorReadRouter(options: { enabled: () => boolean; key: () => string; snapshot: () => Promise<unknown> }) {
  const router = Router();
  let windowStart = 0, requests = 0;
  router.all("/punpan_020/snapshot", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!options.enabled() || options.key().length < 32) { res.status(503).json({ error: { code: "CREATOR_READ_DISABLED" } }); return; }
    if (!creatorReadAuthorized(req.headers["x-creator-read-key"], options.key())) { res.status(401).json({ error: { code: "UNAUTHORIZED" } }); return; }
    if (req.method !== "GET") { res.set("Allow", "GET").status(405).json({ error: { code: "READ_ONLY" } }); return; }
    if (Object.keys(req.query).length) { res.status(400).json({ error: { code: "FIXED_CREATOR_SCOPE" } }); return; }
    if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); requests = 0; }
    if (++requests > 20) { res.status(429).json({ error: { code: "RATE_LIMITED" } }); return; }
    try { res.json(await options.snapshot()); }
    catch (error) { res.status(502).json({ error: { code: error instanceof CreatorReadError ? error.code : "CREATOR_READ_UNAVAILABLE" } }); }
  });
  return router;
}
export const creatorReadRouter = createCreatorReadRouter({
  enabled: () => process.env.CREATOR_READ_ENABLED === "true",
  key: () => process.env.CREATOR_READ_BRIDGE_KEY ?? "",
  snapshot: createCreatorReader({ loadToken: loadCreatorToken }),
});
