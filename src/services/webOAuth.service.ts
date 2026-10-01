import { randomBytes, randomUUID } from "crypto";
import axios from "axios";
import { AppDataSource } from "../db/dataSource";
import { config, missingTikTokOAuthEnvVars } from "../config";
import { encryptSecret } from "../utils/crypto";
import { AppError, describeError } from "../utils/errors";
import { logger } from "../utils/logger";

/** TikTok OAuth started from the web app: createAuthorizeLink -> handleOAuthCallback. */

const STATE_TTL_MS = 30 * 60 * 1000;

function assertOAuthEnabled(): void {
  if (!config.tiktokOAuth.enabled) {
    const missing = missingTikTokOAuthEnvVars();
    throw new AppError(
      `TikTok OAuth ยังไม่ได้ตั้งค่า, ขาด env var: ${missing.join(", ")}`,
      "OAUTH_NOT_CONFIGURED",
      503,
      { missing }
    );
  }
}

export interface CreateAuthorizeLinkInput {
  targetAdvertiserId: string;
  storeId?: string;
  createdByUserId?: number;
}

export interface CreateAuthorizeLinkResult {
  url: string;
  expiresAt: string;
}

export async function createAuthorizeLink(
  input: CreateAuthorizeLinkInput
): Promise<CreateAuthorizeLinkResult> {
  assertOAuthEnabled();

  const state = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + STATE_TTL_MS);

  await AppDataSource.query(
    `INSERT INTO web_oauth_states (state, target_advertiser_id, store_id, created_by_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [state, input.targetAdvertiserId, input.storeId ?? null, input.createdByUserId ?? null, expiresAt]
  );

  // Built directly, no intermediate /start redirect hop like the bot's flow has.
  const url =
    `https://business-api.tiktok.com/portal/auth` +
    `?app_id=${encodeURIComponent(config.tiktokOAuth.appId)}` +
    `&state=${encodeURIComponent(state)}` +
    `&redirect_uri=${encodeURIComponent(config.tiktokOAuth.redirectUri)}`;

  return { url, expiresAt: expiresAt.toISOString() };
}

export type OAuthCallbackStatus = "ok" | "mismatch" | "error";

export interface HandleOAuthCallbackInput {
  authCode?: string;
  state?: string;
}

export interface HandleOAuthCallbackResult {
  status: OAuthCallbackStatus;
  targetAdvertiserId?: string;
  /** oauth_tokens rows inserted, one per advertiser_id TikTok returned. */
  grantedCount: number;
  /** Only on "error". Must not contain secrets, it goes into the redirect URL. */
  detail?: string;
}

interface TikTokTokenExchangeData {
  access_token: string;
  advertiser_ids?: string[];
  scope?: unknown;
}

interface TikTokTokenExchangeResponse {
  code: number;
  message: string;
  data: TikTokTokenExchangeData;
}

export async function handleOAuthCallback(
  input: HandleOAuthCallbackInput
): Promise<HandleOAuthCallbackResult> {
  const { authCode, state } = input;

  // 1. Both params required before anything else happens.
  if (!authCode || !state) {
    logger.warn("OAuth callback missing auth_code or state", {
      hasAuthCode: Boolean(authCode),
      hasState: Boolean(state),
    });
    return { status: "error", grantedCount: 0, detail: "missing auth_code or state" };
  }

  // 2. Consume the state first so it can never be reused.
  const deleted: { state: string; target_advertiser_id: string; expires_at: Date }[] =
    await AppDataSource.query(
      `DELETE FROM web_oauth_states WHERE state = $1
       RETURNING state, target_advertiser_id, expires_at`,
      [state]
    );
  const stateRow = deleted[0];

  if (!stateRow) {
    logger.warn("OAuth callback: unknown or already-used state", { state });
    return { status: "error", grantedCount: 0, detail: "unknown or already-used state" };
  }

  const targetAdvertiserId = stateRow.target_advertiser_id;

  if (new Date(stateRow.expires_at).getTime() < Date.now()) {
    logger.warn("OAuth callback: state expired", { state, targetAdvertiserId });
    return { status: "error", targetAdvertiserId, grantedCount: 0, detail: "state expired" };
  }

  // 3. Exchange auth_code for an access token.
  let data: TikTokTokenExchangeData;
  try {
    const response = await axios.post<TikTokTokenExchangeResponse>(
      `${config.tiktok.baseUrl}/oauth2/access_token/`,
      {
        app_id: config.tiktokOAuth.appId,
        secret: config.tiktokOAuth.appSecret,
        auth_code: authCode,
      },
      { timeout: config.tiktok.timeoutMs }
    );

    // HTTP 200 either way, TikTok signals failure through `code`, not the status line.
    if (response.data.code !== 0) {
      logger.warn("OAuth token exchange rejected by TikTok", {
        targetAdvertiserId,
        code: response.data.code,
        message: response.data.message,
      });
      return {
        status: "error",
        targetAdvertiserId,
        grantedCount: 0,
        detail: `TikTok: ${response.data.message}`,
      };
    }

    data = response.data.data;
  } catch (err) {
    logger.error("OAuth token exchange request failed", {
      targetAdvertiserId,
      error: describeError(err),
    });
    return {
      status: "error",
      targetAdvertiserId,
      grantedCount: 0,
      detail: "token exchange request failed",
    };
  }

  const advertiserIds = data.advertiser_ids ?? [];
  if (advertiserIds.length === 0) {
    logger.warn("OAuth token exchange returned no advertiser_ids", { targetAdvertiserId });
    return {
      status: "error",
      targetAdvertiserId,
      grantedCount: 0,
      detail: "TikTok granted no advertiser accounts",
    };
  }

  // 4. Insert one row per advertiser (readers take the latest by authorized_at).
  const encrypted = encryptSecret(data.access_token);
  const authorizedAt = new Date();
  for (const advertiserId of advertiserIds) {
    await AppDataSource.query(
      `INSERT INTO oauth_tokens (id, advertiser_id, access_token, authorized_at)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), advertiserId, encrypted, authorizedAt]
    );
  }

  // 5. The user picks the account on TikTok's page, so it may not be the one requested.
  const status: OAuthCallbackStatus = advertiserIds.includes(targetAdvertiserId) ? "ok" : "mismatch";

  logger.info("OAuth callback completed", {
    targetAdvertiserId,
    status,
    grantedCount: advertiserIds.length,
  });

  return { status, targetAdvertiserId, grantedCount: advertiserIds.length };
}

/** Called from the sync cron. */
export async function cleanupExpiredWebOAuthStates(): Promise<void> {
  try {
    await AppDataSource.query(`DELETE FROM web_oauth_states WHERE expires_at < now()`);
  } catch (err) {
    logger.warn("web_oauth_states cleanup failed", { error: describeError(err) });
  }
}
