import { Router } from "express";
import type { ErrorRequestHandler, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { bangkokDay, CREATOR_BINDING, CreatorReadError, createCreatorReader } from "../services/creatorRead.service";
import { createCreatorAutomationPerformance } from "../services/creatorAutomationPerformance.service";
import { CREATOR_DAY_MAX_ROWS, createCreatorCampaignDayReader, type CreatorCampaignDay, type CreatorCampaignDayRow } from "../services/creatorCampaignDay.service";
import { createCreatorIdentityUsernameReader, verifiedTikTokUsername } from "../services/creatorIdentityUsername.service";
import { createAutomationReadRegistry, parseExtraAutomationClients, parseVerifiedAutomationBindings,
  PPAN_AUTOMATION_CREATOR, validAutomationClientId } from "../services/creatorAutomationRegistry.service";
import type { AutomationAccessReason, AutomationCreator, AutomationCreatorReadAdapter, AutomationCreatorReadEntry,
  AutomationPerformanceScope } from "../services/creatorAutomationRegistry.service";
import { createVerifiedExtraCreatorReadAdapter } from "../services/creatorAutomationExtraRead.service";
import { AppError } from "../utils/errors";
import { loadCreatorToken } from "./creatorRead.route";

const MAX_SNAPSHOT_AGE_MS = 30_000;
const MAX_PERFORMANCE_AGE_MS = 190_000; // 3m server cache plus bounded provider fetch allowance.
const MAX_CAMPAIGN_DAY_AGE_MS = 35_000;
const MAX_VIEWERS = 100;
const VIEWER_WINDOW_MS = 60_000;
const VIEWER_REQUEST_LIMIT = 24;
const ACTIONS = Object.freeze({ start: false, pause: false, increaseBudget: false, decreaseBudget: false, auto: false });

type UnknownRecord = Record<string, unknown>;
type AutomationRouteDependencies = {
  viewerIds: () => string | undefined;
  readSnapshot: () => Promise<unknown>;
  readPerformance: (scope: AutomationPerformanceScope) => Promise<unknown>;
  readCampaignDay?: () => Promise<unknown>;
  readUsername?: () => Promise<string | null>;
  configuredExtraClients?: () => string | undefined;
  verifiedExtras?: () => readonly AutomationCreatorReadAdapter[];
  pendingReason?: (creator: AutomationCreator) => AutomationAccessReason | undefined;
  now?: () => Date;
};
type Campaign = { campaignId: string; campaignName: string; campaignStatus: "ACTIVE"; dailyBudgetMinor: number;
  spendMinor: number | null; targetRoi: number | null; currency: "THB";
  scheduleStartAt: string | null; scheduleEndAt: string | null; viewerBoostBudgetMinor: number | null };
type Observation = { observedAt: string; reportingDate: string; campaign: Campaign | null };
type ObservationResult = { view: Observation; accessReason?: never } | { view: null; accessReason: AutomationAccessReason };
type PerformancePoint = { hour: string; spendMinor: number | null; gmvMinor: number | null;
  orders: number | null; roi: number | null; liveViews: number | null };
type PerformanceObservation = { observedAt: string; series: PerformancePoint[] };

/** An explicit positive-ID list only; a malformed entry invalidates the whole grant. */
export function parseAutomationViewerIds(raw: string | undefined): ReadonlySet<number> {
  if (!raw || raw.length > 2_000) return new Set();
  const entries = raw.split(",").map(value => value.trim());
  if (entries.length > MAX_VIEWERS || entries.some(value => !/^[1-9]\d*$/.test(value))) return new Set();
  const ids = entries.map(Number);
  return ids.every(Number.isSafeInteger) ? new Set(ids) : new Set();
}

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function nullableInteger(value: unknown): value is number | null { return value === null || nonnegativeInteger(value); }
function nullableRatio(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}
function canonicalScheduleTime(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? value : null;
}
function freshObservationTime(value: unknown, reportingDate: string, now: Date, maxAgeMs: number): value is string {
  if (typeof value !== "string") return false;
  const observed = new Date(value);
  const age = now.getTime() - observed.getTime();
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs && observed.toISOString() === value
    && reportingDate === bangkokDay(now) && reportingDate === bangkokDay(observed);
}

function verifyObservation(raw: UnknownRecord, now: Date, adapter: AutomationCreatorReadAdapter): Observation | null {
  if (raw.schemaVersion !== 1 || raw.clientId !== adapter.clientId || raw.readOnly !== true
    || raw.source !== "tiktok-creator-api" || raw.timezone !== "Asia/Bangkok") return null;
  if (typeof raw.reportingDate !== "string" || !freshObservationTime(raw.observedAt, raw.reportingDate, now, MAX_SNAPSHOT_AGE_MS)) return null;
  const { observedAt, reportingDate } = raw;
  const campaign = raw.campaign;
  if (campaign === null) return { observedAt, reportingDate, campaign: null };
  if (!record(campaign) || typeof campaign.campaignId !== "string" || !/^[1-9]\d{5,30}$/.test(campaign.campaignId)
    || campaign.status !== "ACTIVE" || campaign.operationStatus !== "ENABLE" || campaign.currency !== "THB"
    || !nonnegativeInteger(campaign.dailyBudgetMinor) || campaign.dailyBudgetMinor === 0
    || !nullableInteger(campaign.spendMinor) || !nullableRatio(campaign.targetRoi)) return null;
  const campaignName = typeof campaign.campaignName === "string"
    ? campaign.campaignName.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, 160).trim() : "";
  const start = canonicalScheduleTime(campaign.scheduleStartAt), end = canonicalScheduleTime(campaign.scheduleEndAt);
  const validSchedule = start !== null && (campaign.scheduleEndAt == null || (end !== null && end > start));
  return { observedAt, reportingDate, campaign: { campaignId: campaign.campaignId, campaignName: campaignName || "แคมเปญ Creator",
    campaignStatus: "ACTIVE", dailyBudgetMinor: campaign.dailyBudgetMinor, spendMinor: campaign.spendMinor,
    targetRoi: campaign.targetRoi, currency: "THB", scheduleStartAt: validSchedule ? start : null,
    scheduleEndAt: validSchedule ? end : null,
    // TikTok documents Viewer Boost as a separate, additional budget. The
    // verified no-Shop Creator read does not establish that value or a zero.
    viewerBoostBudgetMinor: null } };
}

function verifyPerformance(raw: unknown, reportingDate: string, now: Date): PerformanceObservation | null {
  if (!record(raw) || raw.state !== "available" || !Array.isArray(raw.series) || raw.series.length > 24
    || !freshObservationTime(raw.observedAt, reportingDate, now, MAX_PERFORMANCE_AGE_MS)) return null;
  const points: PerformancePoint[] = [], seen = new Set<string>();
  for (const row of raw.series) {
    if (!record(row) || typeof row.hour !== "string" || !/^(?:[01]\d|2[0-3]):00$/.test(row.hour) || seen.has(row.hour)
      || !nullableInteger(row.spendMinor) || !nullableInteger(row.gmvMinor) || !nullableInteger(row.orders)
      || !nullableRatio(row.roi) || !nullableInteger(row.liveViews)) return null;
    seen.add(row.hour);
    points.push({ hour: row.hour, spendMinor: row.spendMinor, gmvMinor: row.gmvMinor, orders: row.orders,
      roi: row.roi, liveViews: row.liveViews });
  }
  return { observedAt: raw.observedAt, series: points.sort((a, b) => a.hour.localeCompare(b.hour)) };
}

function verifyCampaignDay(raw: unknown, now: Date): CreatorCampaignDay {
  const reportingDate = bangkokDay(now);
  const unavailable: CreatorCampaignDay = { reportingDate, observedAt: null, coverage: "unavailable", campaigns: [] };
  if (!record(raw) || raw.reportingDate !== reportingDate || (raw.coverage !== "complete" && raw.coverage !== "partial") ||
    !freshObservationTime(raw.observedAt, reportingDate, now, MAX_CAMPAIGN_DAY_AGE_MS) ||
    !Array.isArray(raw.campaigns) || raw.campaigns.length > CREATOR_DAY_MAX_ROWS) return unavailable;
  const campaigns: CreatorCampaignDayRow[] = [], seen = new Set<string>();
  for (const campaign of raw.campaigns) {
    if (!record(campaign) || typeof campaign.campaignId !== "string" || !/^[1-9]\d{5,30}$/.test(campaign.campaignId) || seen.has(campaign.campaignId) ||
      typeof campaign.activityToday !== "boolean" || !nullableInteger(campaign.spendMinor) || !nullableInteger(campaign.gmvMinor) ||
      !nullableInteger(campaign.dailyBudgetMinor) || campaign.dailyBudgetMinor === 0 || !nullableRatio(campaign.targetRoi) ||
      (campaign.operationStatus !== "ENABLE" && campaign.operationStatus !== "DISABLE" && campaign.operationStatus !== "DELETE") ||
      (campaign.operationStatus !== "ENABLE" && !campaign.activityToday)) return unavailable;
    const name = typeof campaign.campaignName === "string" ? campaign.campaignName.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, 160).trim() : "";
    const start = canonicalScheduleTime(campaign.scheduleStartAt), end = canonicalScheduleTime(campaign.scheduleEndAt);
    const scheduleVerified = start !== null && (campaign.scheduleEndAt === null || (end !== null && end > start));
    const roi = campaign.gmvMinor !== null && campaign.spendMinor !== null && campaign.spendMinor > 0 ? campaign.gmvMinor / campaign.spendMinor : null;
    seen.add(campaign.campaignId);
    const skuOrders = campaign.skuOrders ?? null, liveViews = campaign.liveViews ?? null;
    if (!nullableInteger(skuOrders) || !nullableInteger(liveViews)) return unavailable;
    campaigns.push({ campaignId: campaign.campaignId, campaignName: name || "แคมเปญ Creator", operationStatus: campaign.operationStatus,
      dailyBudgetMinor: campaign.dailyBudgetMinor, targetRoi: campaign.targetRoi, spendMinor: campaign.spendMinor, gmvMinor: campaign.gmvMinor,
      skuOrders, liveViews, roi, activityToday: campaign.activityToday, scheduleStartAt: scheduleVerified ? start : null, scheduleEndAt: scheduleVerified ? end : null });
  }
  campaigns.sort((a, b) => Number(b.operationStatus === "ENABLE") - Number(a.operationStatus === "ENABLE") ||
    b.campaignId.length - a.campaignId.length || b.campaignId.localeCompare(a.campaignId));
  return { reportingDate, observedAt: raw.observedAt, coverage: raw.coverage, campaigns };
}

export function createAutomationRouter({ viewerIds, readSnapshot, readPerformance, readCampaignDay, readUsername, configuredExtraClients, verifiedExtras,
  pendingReason, now = () => new Date() }: AutomationRouteDependencies) {
  const router = Router();
  let windowStart = -Infinity;
  const viewerRequests = new Map<number, number>();
  const registry = () => createAutomationReadRegistry({ extraConfig: configuredExtraClients?.(),
    ppan: { readSnapshot, readPerformance, readCampaignDay, readUsername }, verifiedExtras: verifiedExtras?.(), pendingReason });

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store").vary("Authorization");
    next();
  });
  router.use(requireAuth);
  router.use((req, res, next) => {
    const viewer = req.user?.sub;
    const allowed = parseAutomationViewerIds(viewerIds());
    if (viewer === undefined || !allowed.has(viewer)) {
      res.status(403).json({ error: { code: "AUTOMATION_ACCESS_DENIED", message: "บัญชีนี้ยังไม่ได้รับสิทธิ์ดู Automation" } });
      return;
    }
    const time = now().getTime();
    if (time < windowStart || time - windowStart >= VIEWER_WINDOW_MS) { windowStart = time; viewerRequests.clear(); }
    if (viewerRequests.size >= MAX_VIEWERS) for (const id of viewerRequests.keys()) if (!allowed.has(id)) viewerRequests.delete(id);
    const count = (viewerRequests.get(viewer) ?? 0) + 1;
    if (count > VIEWER_REQUEST_LIMIT) {
      res.set("Retry-After", "60").status(429).json({ error: { code: "AUTOMATION_RATE_LIMITED", message: "รอสักครู่ก่อนโหลด Automation อีกครั้ง" } });
      return;
    }
    viewerRequests.set(viewer, count);
    next();
  });

  function fixedGet(req: Request, res: Response): boolean {
    if (req.method !== "GET") {
      res.set("Allow", "GET").status(405).json({ error: { code: "READ_ONLY", message: "Automation รุ่นนี้เปิดให้อ่านเท่านั้น" } });
      return false;
    }
    if (req.originalUrl.includes("?")) {
      res.status(400).json({ error: { code: "FIXED_CREATOR_SCOPE", message: "Automation รุ่นนี้อ่านเฉพาะบัญชี Creator ที่ตั้งค่าไว้" } });
      return false;
    }
    return true;
  }

  async function observe(entry: AutomationCreatorReadEntry): Promise<ObservationResult> {
    if (!entry.adapter) return { view: null, accessReason: entry.accessReason };
    try {
      const raw = await entry.adapter.readSnapshot();
      if (!record(raw)) return { view: null, accessReason: "upstream-unavailable" };
      const binding = raw.binding;
      if (!record(binding) || !Object.entries(entry.adapter.binding).every(([key, expected]) => binding[key] === expected)) {
        return { view: null, accessReason: "identity-unverified" };
      }
      const view = verifyObservation(raw, now(), entry.adapter);
      return view ? { view } : { view: null, accessReason: "upstream-unavailable" };
    } catch (error) {
      if (error instanceof CreatorReadError && error.code === "CREATOR_PERMISSION_DENIED") {
        return { view: null, accessReason: "needs-authorization" };
      }
      if (error instanceof CreatorReadError && error.code === "CREATOR_IDENTITY_BINDING_UNVERIFIED") {
        return { view: null, accessReason: "identity-unverified" };
      }
      return { view: null, accessReason: "upstream-unavailable" };
    }
  }

  router.all("/overview", async (req, res, next) => {
    try {
      if (!fixedGet(req, res)) return;
      const clients = await Promise.all(registry().map(async entry => {
        const [{ view, accessReason }, tiktokUsername] = await Promise.all([observe(entry),
          Promise.resolve().then(() => entry.adapter?.readUsername?.()).then(verifiedTikTokUsername).catch(() => null)]);
        return { ...entry.creator, tiktokAccountIdVerified: entry.creator.clientId === PPAN_AUTOMATION_CREATOR.clientId,
          tiktokUsername,
          access: view ? "verified" : "unavailable", ...(accessReason ? { accessReason } : {}),
          observedAt: view?.observedAt ?? null, reportingDate: view?.reportingDate ?? null,
          campaign: view?.campaign ?? null, capMinor: null, actions: ACTIONS };
      }));
      res.json({ schemaVersion: 1, checkedAt: now().toISOString(), coverage: "configured-creators-only", clients });
    } catch (error) { next(error); }
  });

  router.all(["/performance", "/performance/:clientId"], async (req, res, next) => {
    try {
      if (!fixedGet(req, res)) return;
      const clientId = req.params.clientId ?? PPAN_AUTOMATION_CREATOR.clientId;
      const entry = validAutomationClientId(clientId) ? registry().find(candidate => candidate.creator.clientId === clientId) : undefined;
      if (!entry) {
        res.status(404).json({ error: { code: "CREATOR_NOT_CONFIGURED", message: "ไม่พบ Creator ในรายการ Automation" } });
        return;
      }
      const { view } = await observe(entry);
      const campaignId = view?.campaign?.campaignId ?? null;
      const reportingDate = view?.reportingDate ?? null;
      let performance: PerformanceObservation | null = null;
      if (campaignId && reportingDate && entry.adapter) {
        try {
          performance = verifyPerformance(await entry.adapter.readPerformance({ campaignId, reportingDate }), reportingDate, now());
        } catch { /* Provider data is optional; do not expose errors or tokens to the browser. */ }
      }
      res.json({ schemaVersion: 1, checkedAt: now().toISOString(), clientId, campaignId, reportingDate,
        granularity: "hour", state: performance ? "available" : view && !campaignId ? "no-active-campaign" : "unavailable",
        observedAt: performance?.observedAt ?? null, series: performance?.series ?? [] });
    } catch (error) { next(error); }
  });

  router.all("/campaigns/:clientId", async (req, res, next) => {
    try {
      if (!fixedGet(req, res)) return;
      const { clientId } = req.params;
      const entry = validAutomationClientId(clientId) ? registry().find(candidate => candidate.creator.clientId === clientId) : undefined;
      if (!entry) {
        res.status(404).json({ error: { code: "CREATOR_NOT_CONFIGURED", message: "ไม่พบ Creator ในรายการ Automation" } });
        return;
      }
      let raw: unknown;
      try { raw = await entry.adapter?.readCampaignDay?.(); } catch { /* Do not expose provider or credential errors. */ }
      const checked = now();
      res.json({ schemaVersion: 1, checkedAt: checked.toISOString(), clientId, ...verifyCampaignDay(raw, checked) });
    } catch (error) { next(error); }
  });

  // Unlike the generic report error handler, this private boundary never echoes an upstream/database exception.
  const safeError: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) { next(error); return; }
    if (error instanceof AppError && error.httpStatus === 401) {
      res.status(401).json({ error: { code: "AUTH_FAILED", message: "กรุณาเข้าสู่ระบบใหม่เพื่อดู Automation" } });
      return;
    }
    res.status(503).json({ error: { code: "AUTOMATION_UNAVAILABLE", message: "Automation ยังไม่พร้อมให้ดูข้อมูล" } });
  };
  router.use(safeError);
  return router;
}

const creatorSnapshot = createCreatorReader({ loadToken: loadCreatorToken });
const creatorPerformance = createCreatorAutomationPerformance({ loadToken: loadCreatorToken });
const creatorCampaignDay = createCreatorCampaignDayReader({ loadToken: loadCreatorToken }, CREATOR_BINDING);
const creatorUsername = createCreatorIdentityUsernameReader({ loadToken: loadCreatorToken }, CREATOR_BINDING);
const creatorReadEnabled = () => process.env.CREATOR_READ_ENABLED === "true";
const configuredExtraClients = () => process.env.CREATOR_AUTOMATION_EXTRA_READ_CLIENTS;
const configuredVerifiedBindings = () => process.env.CREATOR_AUTOMATION_VERIFIED_READ_BINDINGS;
let cachedExtraAdapters: { metadata?: string; verified?: string; adapters: readonly AutomationCreatorReadAdapter[] } | undefined;
function verifiedExtraAdapters(): readonly AutomationCreatorReadAdapter[] {
  if (!creatorReadEnabled()) return [];
  const metadata = configuredExtraClients();
  const verified = configuredVerifiedBindings();
  if (!cachedExtraAdapters || cachedExtraAdapters.metadata !== metadata || cachedExtraAdapters.verified !== verified) {
    const bindings = parseVerifiedAutomationBindings(verified, parseExtraAutomationClients(metadata));
    cachedExtraAdapters = { metadata, verified, adapters: bindings.map(binding => createVerifiedExtraCreatorReadAdapter(binding)) };
  }
  return cachedExtraAdapters.adapters;
}
export const automationRouter = createAutomationRouter({
  viewerIds: () => process.env.CREATOR_AUTOMATION_VIEWER_USER_IDS,
  configuredExtraClients,
  verifiedExtras: verifiedExtraAdapters,
  pendingReason: () => !creatorReadEnabled() ? "upstream-unavailable"
    : configuredVerifiedBindings() ? "identity-unverified" : "needs-authorization",
  readSnapshot: () => creatorReadEnabled() ? creatorSnapshot() : Promise.resolve(null),
  readPerformance: scope => creatorReadEnabled() ? creatorPerformance(scope) : Promise.resolve(null),
  readCampaignDay: () => creatorReadEnabled() ? creatorCampaignDay() : Promise.resolve(null),
  readUsername: () => creatorReadEnabled() ? creatorUsername() : Promise.resolve(null),
});
