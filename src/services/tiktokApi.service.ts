import axios, { AxiosInstance, AxiosError } from "axios";
import { API_LIMITS, config } from "../config";
import { TikTokApiError, TokenExpiredError } from "../utils/errors";
import { logger } from "../utils/logger";
import { backoffDelayMs, rateLimitDelayMs, RateLimiter, sleep } from "../utils/throttle";

/**
 * TikTok Business API client (read-only endpoints):
 *   GET /gmv_max/store/list/                  (v1.3)
 *   GET /gmv_max/identity/get/                (v1.3)
 *   GET /gmv_max/video/get/                   (v1.3)
 *   GET /gmv_max/report/get/                  (v1.3)
 *   GET /campaign/gmv_max/info/               (v1.3)
 *   GET /gmv_max/video_list/report/get/       (v2.0)
 *
 * Campaign create/update is handled by gmv-max-telegram-bot, not here.
 */

// --- response types ---

export interface TikTokApiResponse<T = unknown> {
  code: number;
  message: string;
  request_id?: string;
  data: T;
}

export interface PageInfo {
  page?: number;
  page_size?: number;
  total_number?: number;
  total_page?: number;
}

export interface Store {
  store_id: string;
  store_name?: string;
  store_code?: string;
  /** Whether this shop can be used for GMV Max at all. */
  is_gmv_max_available?: boolean;
  /** The mandatory companion to store_id on every other GMV Max call. */
  store_authorized_bc_id?: string;
  is_owner_bc?: boolean;
  store_status?: "ACTIVE" | "INACTIVE" | "NEW_CREATE";
  store_role?: "AD_PROMOTION" | "MANAGER" | "UNSET";
  targeting_region_codes?: string[];
  store_authorized_bc_info?: {
    bc_id?: string;
    bc_name?: string;
    user_role?: "ADMIN" | "STANDARD";
  };
  exclusive_authorized_advertiser_info?: {
    advertiser_id?: string;
    advertiser_name?: string;
    advertiser_status?: string;
  };
}

export interface CampaignInfo {
  campaign_id?: string;
  campaign_name?: string;
  /** Target ROI, "ROI เป้าหมาย" in Ads Manager. */
  roas_bid?: number;
  budget?: number;
  operation_status?: string;
  optimization_goal?: string;
  schedule_type?: string;
  schedule_start_time?: string;
  schedule_end_time?: string;
  auto_budget_enabled?: boolean;
  roi_protection_enabled?: boolean;
  /** When true, item_list / identity_list / custom_anchor_video_list are empty. */
  affiliate_posts_enabled?: boolean;
  item_list?: unknown[];
  identity_list?: unknown[];
  custom_anchor_video_list?: unknown[];
  campaign_custom_anchor_video_id?: string;
}

export type IdentityType = "AUTH_CODE" | "TT_USER" | "BC_AUTH_TT" | "TTS_TT";

export interface Identity {
  identity_id: string;
  identity_type: IdentityType;
  display_name?: string;
  /** @handle. Not present for TTS_TT identities. */
  user_name?: string;
  profile_image?: string;
  product_gmv_max_available?: boolean;
  live_gmv_max_available?: boolean;
  /** Only present when live_gmv_max_available is false: OCCUPIED | UNAUTHORIZED. */
  unavailable_reason?: string;
  is_running_custom_shop_ads?: boolean;
  identity_authorized_bc_id?: string;
  identity_authorized_shop_id?: string;
  store_id?: string;
}

export interface VideoItem {
  /** The post id. This is the "Video ID" and the join key against report dimensions.item_id. */
  item_id: string;
  /** SPU ids = "Product ID". One video can carry several, so rows get exploded downstream. */
  spu_id_list?: string[];
  identity_info?: {
    identity_id?: string;
    identity_type?: IdentityType;
    /** NOT the real username, resolve identity_id against /identity/get/ instead. */
    display_name?: string;
  };
  video_info?: {
    /** Asset id of the video file, a different id from item_id. Carried as an extra column. */
    video_id?: string;
    [key: string]: unknown;
  };
}

export type MetricValue = string | number | null;

export interface ReportRow {
  dimensions: Record<string, string>;
  metrics: Record<string, MetricValue>;
}

/** The identity fields /gmv_max/video/get/ accepts inside identity_list. */
export interface IdentityListEntry {
  identity_type: IdentityType;
  identity_id: string;
  identity_authorized_bc_id?: string;
  identity_authorized_shop_id?: string;
  store_id?: string;
}

export interface StoreContext {
  advertiserId: string;
  storeId: string;
  storeAuthorizedBcId: string;
}

// --- error classification ---

const AUTH_ERROR_CODES = new Set([40001, 40100, 40101, 40102, 40103, 40104, 40105, 40110]);

function isAuthError(code: number, message: string): boolean {
  if (AUTH_ERROR_CODES.has(code)) return true;
  return /access[_ ]?token/i.test(message) && /(expire|invalid|revoke|incorrect|unauthorized)/i.test(message);
}

function isRateLimitError(code: number, message: string): boolean {
  if (code === 40016 || code === 51021) return true;
  return /rate limit|too many request|qps|qpm|frequenc/i.test(message);
}

function isRetryableTransportError(err: AxiosError): boolean {
  if (!err.response) return true; // timeout / DNS / socket reset
  return err.response.status === 429 || err.response.status >= 500;
}

/** Extracts the rejected metric names from TikTok's error message. */
export function extractInvalidMetrics(message: string, requested: readonly string[]): string[] {
  return requested.filter((metric) => new RegExp(`\\b${metric}\\b`).test(message));
}

function isInvalidParamError(code: number, message: string): boolean {
  return code === 40002 || /invalid|not support|unsupported/i.test(message);
}

// --- client ---

export type ApiVersion = "v1.3" | "v2.0";

// Shared per advertiser across all client instances (TikTok limits per advertiser).
const limiters = new Map<string, RateLimiter>();

function limiterFor(advertiserId: string): RateLimiter {
  let limiter = limiters.get(advertiserId);
  if (!limiter) {
    limiter = new RateLimiter(config.tiktok.maxQps, config.tiktok.maxQpm);
    limiters.set(advertiserId, limiter);
  }
  return limiter;
}

export class TikTokApiService {
  private readonly clients: Record<ApiVersion, AxiosInstance>;
  private readonly limiter: RateLimiter;

  constructor(private readonly accessToken: string, private readonly advertiserId: string) {
    const v1 = config.tiktok.baseUrl;
    const v2 = v1.replace(/\/v1\.3$/, "/v2.0");
    const make = (baseURL: string) =>
      axios.create({
        baseURL,
        timeout: config.tiktok.timeoutMs,
        headers: { "Content-Type": "application/json" },
      });

    this.clients = { "v1.3": make(v1), "v2.0": make(v2) };
    this.limiter = limiterFor(advertiserId);
  }

  /** Throttled GET with retry-on-backoff. Every call in this file goes through it. */
  private async get<T>(
    path: string,
    params: Record<string, unknown>,
    version: ApiVersion = "v1.3"
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= config.tiktok.maxRetries; attempt++) {
      await this.limiter.acquire();

      try {
        const response = await this.clients[version].get<TikTokApiResponse<T>>(path, {
          params,
          headers: { "Access-Token": this.accessToken },
        });
        const body = response.data;

        if (body.code === 0) return body.data;

        if (isAuthError(body.code, body.message)) {
          throw new TokenExpiredError(this.advertiserId, body.message);
        }

        if (isRateLimitError(body.code, body.message) && attempt < config.tiktok.maxRetries) {
          const delay = rateLimitDelayMs(attempt);
          logger.warn("TikTok rate limited, backing off", { path, attempt, delay, message: body.message });
          await sleep(delay);
          continue;
        }

        throw new TikTokApiError(path, body.code, body.message, body.request_id);
      } catch (err) {
        // Deliberate errors are final; only transport-level trouble is worth retrying.
        if (err instanceof TokenExpiredError || err instanceof TikTokApiError) throw err;

        lastError = err;
        const axiosErr = err as AxiosError<TikTokApiResponse | undefined>;

        // v2.0 returns errors with a 4xx status, so check the body here too
        const body = axiosErr.response?.data;
        if (body && typeof body.code === "number" && body.code !== 0) {
          if (isAuthError(body.code, body.message)) {
            throw new TokenExpiredError(this.advertiserId, body.message);
          }
          if (isRateLimitError(body.code, body.message) && attempt < config.tiktok.maxRetries) {
            const delay = rateLimitDelayMs(attempt);
            logger.warn("TikTok rate limited, backing off", { path, attempt, delay, message: body.message });
            await sleep(delay);
            continue;
          }
          throw new TikTokApiError(path, body.code, body.message, body.request_id);
        }

        if (!axios.isAxiosError(axiosErr) || !isRetryableTransportError(axiosErr) || attempt >= config.tiktok.maxRetries) {
          throw err;
        }

        const delay = backoffDelayMs(attempt);
        logger.warn("TikTok request failed, retrying", {
          path,
          attempt,
          delay,
          status: axiosErr.response?.status,
          message: axiosErr.message,
        });
        await sleep(delay);
      }
    }

    throw lastError ?? new Error(`TikTok request to ${path} failed after retries`);
  }

  // GET /gmv_max/store/list/

  async listStores(): Promise<Store[]> {
    const data = await this.get<{ store_list?: Store[] }>("/gmv_max/store/list/", {
      advertiser_id: this.advertiserId,
    });
    const stores = data.store_list ?? [];
    logger.info("Fetched stores", { advertiserId: this.advertiserId, count: stores.length });
    return stores;
  }

  // GET /campaign/gmv_max/info/

  /** Campaign settings (budget, ROI target), one campaign per call. */
  async getCampaignInfo(campaignId: string): Promise<CampaignInfo | null> {
    try {
      return await this.get<CampaignInfo>("/campaign/gmv_max/info/", {
        advertiser_id: this.advertiserId,
        campaign_id: campaignId,
      });
    } catch (err) {
      // not fatal, the settings columns are left blank
      if (err instanceof TikTokApiError) {
        logger.warn("Could not read campaign info", { campaignId, message: err.message });
        return null;
      }
      throw err;
    }
  }

  // GET /gmv_max/identity/get/

  /** All identities of a store (not paginated). TTS_TT identities have no user_name. */
  async getIdentities(ctx: StoreContext): Promise<Identity[]> {
    const data = await this.get<{ identity_list?: Identity[] }>("/gmv_max/identity/get/", {
      advertiser_id: ctx.advertiserId,
      store_id: ctx.storeId,
      store_authorized_bc_id: ctx.storeAuthorizedBcId,
    });

    const identities = data.identity_list ?? [];
    logger.info("Fetched identities", { storeId: ctx.storeId, count: identities.length });
    return identities;
  }

  // GET /gmv_max/video/get/

  /**
   * Videos for the given identities, in batches of 20 identities, deduped by item_id.
   * need_auth_code_video is required for AUTH_CODE identities to return anything.
   */
  async getVideos(ctx: StoreContext, identities: IdentityListEntry[]): Promise<VideoItem[]> {
    const byItemId = new Map<string, VideoItem>();
    const batches = chunk(identities, API_LIMITS.identityListPerRequest);

    // No identities at all still deserves one pass, so AUTH_CODE videos aren't missed.
    const passes: (IdentityListEntry[] | null)[] = batches.length > 0 ? batches : [null];

    for (const batch of passes) {
      let page = 1;

      for (;;) {
        const params: Record<string, unknown> = {
          advertiser_id: ctx.advertiserId,
          store_id: ctx.storeId,
          store_authorized_bc_id: ctx.storeAuthorizedBcId,
          need_auth_code_video: true,
          page,
          page_size: API_LIMITS.videoPageSize,
        };
        if (batch && batch.length > 0) {
          params.identity_list = JSON.stringify(batch);
        }

        const data = await this.get<{ item_list?: VideoItem[]; page_info?: PageInfo }>(
          "/gmv_max/video/get/",
          params
        );

        for (const item of data.item_list ?? []) {
          if (item?.item_id) byItemId.set(item.item_id, item);
        }

        const totalPage = data.page_info?.total_page ?? 1;
        if (page >= totalPage) break;
        page += 1;
      }
    }

    logger.info("Fetched videos", {
      storeId: ctx.storeId,
      identityBatches: passes.length,
      uniqueVideos: byItemId.size,
    });
    return [...byItemId.values()];
  }

  // GET /gmv_max/report/get/

  /**
   * Metrics for one store (the API accepts one store id per call). Metrics that TikTok
   * rejects are dropped and the call is retried; dropped names are returned as warnings.
   */
  async getReport(params: {
    advertiserId: string;
    storeId: string;
    startDate: string;
    endDate: string;
    dimensions: string[];
    metrics: readonly string[];
    storeAuthorizedBcId?: string;
    /** Route to the v2.0 video-list report instead of the v1.3 one. */
    videoList?: boolean;
    /** v1.3 only. Item level needs campaign_ids; creative level also needs item_group_ids. */
    filtering?: Record<string, unknown>;
  }): Promise<{ rows: ReportRow[]; droppedMetrics: string[] }> {
    try {
      const rows = await this.fetchReportPages(params, params.metrics);
      return { rows, droppedMetrics: [] };
    } catch (err) {
      if (!(err instanceof TikTokApiError) || !isInvalidParamError(err.apiCode, err.message)) throw err;

      // v2.0 reports one bad metric per response, so keep retrying
      let remaining = [...params.metrics];
      const dropped: string[] = [];
      let lastError = err;

      for (let round = 0; round < params.metrics.length; round++) {
        const invalid = extractInvalidMetrics(lastError.message, remaining);
        if (invalid.length === 0) throw lastError;

        dropped.push(...invalid);
        remaining = remaining.filter((m) => !invalid.includes(m));
        if (remaining.length === 0) throw lastError;

        try {
          const rows = await this.fetchReportPages(params, remaining);
          logger.warn("TikTok rejected metrics, continued without them", {
            dimensions: params.dimensions,
            dropped,
          });
          return { rows, droppedMetrics: dropped };
        } catch (retryErr) {
          if (!(retryErr instanceof TikTokApiError) || !isInvalidParamError(retryErr.apiCode, retryErr.message)) {
            throw retryErr;
          }
          lastError = retryErr;
        }
      }
      throw lastError;
    }
  }

  private async fetchReportPages(
    params: {
      advertiserId: string;
      storeId: string;
      startDate: string;
      endDate: string;
      dimensions: string[];
      storeAuthorizedBcId?: string;
      videoList?: boolean;
      filtering?: Record<string, unknown>;
    },
    metrics: readonly string[]
  ): Promise<ReportRow[]> {
    const collected: ReportRow[] = [];
    let page = 1;

    const path = params.videoList ? "/gmv_max/video_list/report/get/" : "/gmv_max/report/get/";
    const version: ApiVersion = params.videoList ? "v2.0" : "v1.3";

    for (;;) {
      const data = await this.get<{ list?: ReportRow[]; page_info?: PageInfo }>(
        path,
        {
          advertiser_id: params.advertiserId,
          store_ids: JSON.stringify([params.storeId]),
          ...(params.storeAuthorizedBcId ? { store_authorized_bc_id: params.storeAuthorizedBcId } : {}),
          ...(params.filtering ? { filtering: JSON.stringify(params.filtering) } : {}),
          start_date: params.startDate,
          end_date: params.endDate,
          dimensions: JSON.stringify(params.dimensions),
          metrics: JSON.stringify(metrics),
          page,
          page_size: API_LIMITS.reportPageSize,
        },
        version
      );

      collected.push(...(data.list ?? []));

      const totalPage = data.page_info?.total_page ?? 1;
      if (page >= totalPage) break;
      page += 1;
    }

    logger.info("Fetched report rows", {
      endpoint: path,
      storeId: params.storeId,
      dimensions: params.dimensions,
      rows: collected.length,
    });
    return collected;
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
