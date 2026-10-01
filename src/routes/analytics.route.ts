import { Router } from "express";
import { z } from "zod";
import * as analytics from "../services/analytics.service";
import { writeAllMetricsWorkbook, writeLiveRoomsWorkbook } from "../services/excelExport.service";
import { getStoreAuthorization } from "../services/storeAuthorization.service";
import { createAuthorizeLink } from "../services/webOAuth.service";
import { requireAuth } from "../middleware/auth";
import { parsePromotionType } from "./promotionType";
import { ValidationError } from "../utils/errors";

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Everything gmv-max-report-web reads. All JWT-protected. */
export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ต้องเป็น YYYY-MM-DD");

const rangeSchema = z.object({
  /** One id, or several comma-separated. Omitted means every store. */
  storeId: z.string().min(1).optional(),
  campaignId: z.string().min(1).optional(),
  itemGroupId: z.string().min(1).optional(),
  /** LIVE identity_id; ignored by endpoints that don't use it. */
  identityId: z.string().min(1).optional(),
  from: isoDate,
  to: isoDate,
});

function parseRange(query: unknown) {
  const parsed = rangeSchema.safeParse(query);
  if (!parsed.success) {
    throw new ValidationError("ต้องระบุ from และ to เป็น YYYY-MM-DD", {
      issues: parsed.error.issues,
    });
  }
  if (parsed.data.from > parsed.data.to) {
    throw new ValidationError("from ต้องไม่เกิน to");
  }

  // storeId accepts a comma-separated list
  const { storeId, ...rest } = parsed.data;
  const storeIds = (storeId ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  return { ...rest, storeIds };
}

// Only campaign-level endpoints have promotion_type.
function parseCampaignRange(query: unknown) {
  return { ...parseRange(query), promotionType: parsePromotionType(query) };
}

/** GET /analytics/stores: dropdown source; also shows how fresh each store's data is. */
analyticsRouter.get("/stores", async (_req, res, next) => {
  try {
    res.json({ stores: await analytics.listStoresWithData() });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /analytics/store-authorization[?refresh=1]
 * Authorization status of every shop, fetched live from TikTok. Cached for 1 minute.
 */
analyticsRouter.get("/store-authorization", async (req, res, next) => {
  try {
    res.json(await getStoreAuthorization({ refresh: req.query.refresh === "1" }));
  } catch (err) {
    next(err);
  }
});

const authorizeLinkSchema = z.object({
  targetAdvertiserId: z.string().min(1),
  storeId: z.string().min(1).optional(),
});

/**
 * POST /analytics/store-authorization/authorize-link
 * Body { targetAdvertiserId, storeId? } -> { url, expiresAt }. Link is valid for 30 minutes.
 */
analyticsRouter.post("/store-authorization/authorize-link", async (req, res, next) => {
  try {
    const parsed = authorizeLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("ต้องส่ง { targetAdvertiserId }", { issues: parsed.error.issues });
    }

    const result = await createAuthorizeLink({
      targetAdvertiserId: parsed.data.targetAdvertiserId,
      storeId: parsed.data.storeId,
      createdByUserId: req.user?.sub,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** GET /analytics/campaign-options?from&to[&storeId][&promotionType]: dropdown source. */
analyticsRouter.get("/campaign-options", async (req, res, next) => {
  try {
    res.json({ campaigns: await analytics.listCampaignOptions(parseCampaignRange(req.query)) });
  } catch (err) {
    next(err);
  }
});

/** GET /analytics/summary[?promotionType]: KPI cards with the previous period. */
analyticsRouter.get("/summary", async (req, res, next) => {
  try {
    res.json(await analytics.summary(parseCampaignRange(req.query)));
  } catch (err) {
    next(err);
  }
});

/** GET /analytics/timeseries[?promotionType]: one point per day, for the trend chart. */
analyticsRouter.get("/timeseries", async (req, res, next) => {
  try {
    res.json({ points: await analytics.timeseries(parseCampaignRange(req.query)) });
  } catch (err) {
    next(err);
  }
});

const sortSchema = z.object({
  sort: z.string().optional(),
  direction: z.enum(["ASC", "DESC", "asc", "desc"]).optional(),
});

function parseSort(query: unknown): { sort?: string; direction: "ASC" | "DESC" } {
  const parsed = sortSchema.safeParse(query);
  const direction = (parsed.success ? parsed.data.direction : undefined) ?? "DESC";
  return {
    sort: parsed.success ? parsed.data.sort : undefined,
    direction: direction.toUpperCase() === "ASC" ? "ASC" : "DESC",
  };
}

/** GET /analytics/campaigns[?promotionType]: campaign table. */
analyticsRouter.get("/campaigns", async (req, res, next) => {
  try {
    const { sort, direction } = parseSort(req.query);
    res.json({ campaigns: await analytics.campaigns(parseCampaignRange(req.query), sort, direction) });
  } catch (err) {
    next(err);
  }
});

/** GET /analytics/products: product table, optionally scoped to one campaign. */
analyticsRouter.get("/products", async (req, res, next) => {
  try {
    res.json({ products: await analytics.products(parseRange(req.query)) });
  } catch (err) {
    next(err);
  }
});

/** GET /analytics/live-rooms: LIVE room table, optionally scoped to one campaign. */
analyticsRouter.get("/live-rooms", async (req, res, next) => {
  try {
    res.json({ liveRooms: await analytics.liveRooms(parseRange(req.query)) });
  } catch (err) {
    next(err);
  }
});

/** GET /analytics/live-rooms/export: same as /live-rooms, as .xlsx. */
analyticsRouter.get("/live-rooms/export", async (req, res, next) => {
  try {
    const range = parseRange(req.query);
    const rows = await analytics.liveRooms(range);
    const buffer = await writeLiveRoomsWorkbook(rows as Record<string, unknown>[]);

    res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
    res.setHeader("Content-Disposition", `attachment; filename="live-rooms_${range.from}_to_${range.to}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

/** GET /analytics/all: video/creator counts per day. */
analyticsRouter.get("/all", async (req, res, next) => {
  try {
    res.json({ days: await analytics.dailyAllMetrics(parseCampaignRange(req.query)) });
  } catch (err) {
    next(err);
  }
});

/** GET /analytics/all/export: same as /analytics/all, as .xlsx. */
analyticsRouter.get("/all/export", async (req, res, next) => {
  try {
    const range = parseCampaignRange(req.query);
    const rows = await analytics.dailyAllMetrics(range);
    const buffer = await writeAllMetricsWorkbook(rows as Record<string, unknown>[]);

    res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
    res.setHeader("Content-Disposition", `attachment; filename="all_${range.from}_to_${range.to}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

/** GET /analytics/creator-options: LIVE identities for the identityId filter. */
analyticsRouter.get("/creator-options", async (req, res, next) => {
  try {
    res.json({ creators: await analytics.listCreatorOptions(parseRange(req.query)) });
  } catch (err) {
    next(err);
  }
});

const creatorSchema = z.object({ minCost: z.coerce.number().min(0).optional() });

/** GET /analytics/creators: creator ranking. Product cards are excluded. */
analyticsRouter.get("/creators", async (req, res, next) => {
  try {
    const range = parseRange(req.query);
    const { minCost } = creatorSchema.parse(req.query);
    res.json({ creators: await analytics.creators(range, minCost ?? 0) });
  } catch (err) {
    next(err);
  }
});

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  accountName: z.string().min(1).optional(),
  contentType: z.enum(["VIDEO", "PRODUCT_CARD"]).optional(),
});

/** GET /analytics/creatives: the detail table, paginated. */
analyticsRouter.get("/creatives", async (req, res, next) => {
  try {
    const range = parseRange(req.query);
    const { sort, direction } = parseSort(req.query);
    const page = pageSchema.parse(req.query);

    const result = await analytics.creatives(
      { ...range, accountName: page.accountName, contentType: page.contentType },
      sort,
      direction,
      page.limit ?? 100,
      page.offset ?? 0
    );

    res.json({
      creatives: result.rows,
      total: result.total,
      limit: page.limit ?? 100,
      offset: page.offset ?? 0,
    });
  } catch (err) {
    next(err);
  }
});
