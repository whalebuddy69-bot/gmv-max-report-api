import "dotenv/config";
import path from "path";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, got "${raw}"`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true";
}

export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  ssl: boolean;
}

/**
 * DATABASE_URL takes precedence over the DB_* variables. SSL is on for non-local hosts
 * unless DB_SSL or sslmode says otherwise.
 */
function databaseConfig(): DatabaseConfig {
  const url = process.env.DATABASE_URL;

  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("DATABASE_URL is not a valid URL");
    }

    const host = parsed.hostname;
    const sslmode = parsed.searchParams.get("sslmode");
    const looksLocal = host === "localhost" || host === "127.0.0.1" || host.endsWith(".internal");

    return {
      host,
      port: parsed.port ? Number(parsed.port) : 5432,
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname.replace(/^\//, ""),
      ssl: bool("DB_SSL", sslmode ? sslmode !== "disable" : !looksLocal),
    };
  }

  const host = process.env.DB_HOST ?? "localhost";
  const looksLocal = host === "localhost" || host === "127.0.0.1" || host.endsWith(".internal");

  return {
    host,
    port: num("DB_PORT", 5432),
    username: process.env.DB_USERNAME ?? "postgres",
    password: process.env.DB_PASSWORD ?? "",
    database: process.env.DB_NAME ?? "gmvmax_bot",
    ssl: bool("DB_SSL", !looksLocal),
  };
}

export const config = {
  port: num("PORT", 3100),

  db: databaseConfig(),

  tiktok: {
    baseUrl: (process.env.TIKTOK_API_BASE_URL ?? "https://business-api.tiktok.com/open_api/v1.3").replace(
      /\/+$/,
      ""
    ),
    timeoutMs: num("TIKTOK_HTTP_TIMEOUT_MS", 30_000),
    maxQps: num("TIKTOK_MAX_QPS", 8),
    maxQpm: num("TIKTOK_MAX_QPM", 240),
    maxRetries: num("TIKTOK_MAX_RETRIES", 4),
  },

  reportOutputDir: path.resolve(process.env.REPORT_OUTPUT_DIR ?? "./reports"),

  auth: {
    get jwtSecret(): string {
      const secret = process.env.JWT_SECRET;
      if (!secret || secret.length < 32) {
        throw new Error(
          "JWT_SECRET is not set (or shorter than 32 chars). Generate one with: openssl rand -hex 32"
        );
      }
      return secret;
    },
    tokenTtlSeconds: num("JWT_TTL_SECONDS", 12 * 60 * 60),
    internalApiKey: process.env.INTERNAL_API_KEY ?? "",
  },

  /** Comma-separated. "*" allows any origin. */
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:3000,http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  sync: {
    enabled: (process.env.SYNC_ENABLED ?? "false").toLowerCase() === "true",
    cron: process.env.SYNC_CRON ?? "*/30 * * * *",
    /** Days re-pulled on each run. TikTok updates recent days late. Max 30. */
    lookbackDays: num("SYNC_LOOKBACK_DAYS", 3),
    /** Ad account timezone offset (Bangkok = 420). */
    tzOffsetMinutes: num("SYNC_TZ_OFFSET_MINUTES", 420),
    autoDiscover: (process.env.SYNC_AUTO_DISCOVER ?? "true").toLowerCase() === "true",
    runOnStartup: (process.env.SYNC_ON_STARTUP ?? "true").toLowerCase() === "true",
  },

  tiktokOAuth: {
    appId: process.env.TIKTOK_APP_ID ?? "",
    appSecret: process.env.TIKTOK_APP_SECRET ?? "",
    redirectUri: process.env.TIKTOK_OAUTH_REDIRECT_URI ?? "",
    webAppUrl: process.env.WEB_APP_URL ?? "",
    /** When false the OAuth routes return 503 instead of failing at startup. */
    enabled:
      !!process.env.TIKTOK_APP_ID &&
      !!process.env.TIKTOK_APP_SECRET &&
      !!process.env.TIKTOK_OAUTH_REDIRECT_URI &&
      !!process.env.WEB_APP_URL,
  },
};

export function missingTikTokOAuthEnvVars(): string[] {
  const required = ["TIKTOK_APP_ID", "TIKTOK_APP_SECRET", "TIKTOK_OAUTH_REDIRECT_URI", "WEB_APP_URL"];
  return required.filter((name) => !process.env[name]);
}

/** Per-request limits of the TikTok API. */
export const API_LIMITS = {
  identityListPerRequest: 20, // /gmv_max/video/get/
  storeIdsPerRequest: 1, // /gmv_max/report/get/
  videoPageSize: 50,
  reportPageSize: 1000,
  maxReportDays: 365, // without a stat_time_day dimension
} as const;
