import { Router } from "express";
import { config, missingTikTokOAuthEnvVars } from "../config";
import { handleOAuthCallback } from "../services/webOAuth.service";
import { describeError } from "../utils/errors";
import { logger } from "../utils/logger";

export const oauthRouter = Router();

/** GET /oauth/tiktok/callback: always redirects back to the web app. */
oauthRouter.get("/tiktok/callback", async (req, res) => {
  if (!config.tiktokOAuth.enabled) {
    const missing = missingTikTokOAuthEnvVars();
    logger.error("OAuth callback hit while TikTok OAuth is not configured", { missing });
    res.status(503).json({
      error: {
        code: "OAUTH_NOT_CONFIGURED",
        message: `TikTok OAuth ยังไม่ได้ตั้งค่า, ขาด env var: ${missing.join(", ")}`,
      },
    });
    return;
  }

  const authCode = typeof req.query.auth_code === "string" ? req.query.auth_code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;

  try {
    const result = await handleOAuthCallback({ authCode, state });

    const redirectUrl = new URL("/stores", config.tiktokOAuth.webAppUrl);
    redirectUrl.searchParams.set("authz", result.status);
    if (result.targetAdvertiserId) {
      redirectUrl.searchParams.set("advertiser", result.targetAdvertiserId);
    }
    redirectUrl.searchParams.set("granted", String(result.grantedCount));
    if (result.status === "error" && result.detail) {
      redirectUrl.searchParams.set("detail", result.detail);
    }

    res.redirect(302, redirectUrl.toString());
  } catch (err) {
    logger.error("OAuth callback failed unexpectedly", { error: describeError(err) });
    const redirectUrl = new URL("/stores", config.tiktokOAuth.webAppUrl);
    redirectUrl.searchParams.set("authz", "error");
    redirectUrl.searchParams.set("granted", "0");
    redirectUrl.searchParams.set("detail", "unexpected error");
    res.redirect(302, redirectUrl.toString());
  }
});
