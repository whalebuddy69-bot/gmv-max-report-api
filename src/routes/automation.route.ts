import { Router } from "express";
import type { ErrorRequestHandler, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { bangkokDay, CREATOR_BINDING, createCreatorReader } from "../services/creatorRead.service";
import { createCreatorAutomationPerformance } from "../services/creatorAutomationPerformance.service";
import { AppError } from "../utils/errors";
import { loadCreatorToken } from "./creatorRead.route";

const CLIENT_ID = "punpan_020";
const MAX_SNAPSHOT_AGE_MS = 30_000;
const MAX_PERFORMANCE_AGE_MS = 190_000; // 3m server cache plus bounded provider fetch allowance.
const MAX_VIEWERS = 100;
const VIEWER_WINDOW_MS = 60_000;
const VIEWER_REQUEST_LIMIT = 24;
const ACTIONS = Object.freeze({ start: false, pause: false, increaseBudget: false, decreaseBudget: false, auto: false });
const CONFIGURED_CLIENT = Object.freeze({ clientId: CLIENT_ID, displayName: "Ppan", advertiserId: CREATOR_BINDING.advertiserId,
  tiktokAccountId: CREATOR_BINDING.tiktokAccountId });

type UnknownRecord = Record<string, unknown>;
type PerformanceScope = { campaignId: string; reportingDate: string };
type AutomationRouteDependencies = {
  viewerIds: () => string | undefined;
  readSnapshot: () => Promise<unknown>;
  readPerformance: (scope: PerformanceScope) => Promise<unknown>;
  now?: () => Date;
};
type Campaign = { campaignId: string; campaignName: string; campaignStatus: "ACTIVE"; dailyBudgetMinor: number;
  spendMinor: number | null; targetRoi: number | null; currency: "THB" };
type Observation = { observedAt: string; reportingDate: string; campaign: Campaign | null };
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
function freshObservationTime(value: unknown, reportingDate: string, now: Date, maxAgeMs: number): value is string {
  if (typeof value !== "string") return false;
  const observed = new Date(value);
  const age = now.getTime() - observed.getTime();
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs && observed.toISOString() === value
    && reportingDate === bangkokDay(now) && reportingDate === bangkokDay(observed);
}

function verifyObservation(raw: unknown, now: Date): Observation | null {
  if (!record(raw) || raw.schemaVersion !== 1 || raw.clientId !== CLIENT_ID || raw.readOnly !== true
    || raw.source !== "tiktok-creator-api" || raw.timezone !== "Asia/Bangkok" || !record(raw.binding)) return null;
  const binding = raw.binding;
  if (!Object.entries(CREATOR_BINDING).every(([key, expected]) => binding[key] === expected)) return null;
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
  return { observedAt, reportingDate, campaign: { campaignId: campaign.campaignId, campaignName: campaignName || "แคมเปญ Creator",
    campaignStatus: "ACTIVE", dailyBudgetMinor: campaign.dailyBudgetMinor, spendMinor: campaign.spendMinor,
    targetRoi: campaign.targetRoi, currency: "THB" } };
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

export function createAutomationRouter({ viewerIds, readSnapshot, readPerformance, now = () => new Date() }: AutomationRouteDependencies) {
  const router = Router();
  let windowStart = -Infinity;
  const viewerRequests = new Map<number, number>();

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

  async function observe(): Promise<Observation | null> {
    try { return verifyObservation(await readSnapshot(), now()); }
    catch { return null; }
  }

  router.all("/overview", async (req, res, next) => {
    try {
      if (!fixedGet(req, res)) return;
      const view = await observe();
      res.json({ schemaVersion: 1, checkedAt: now().toISOString(), coverage: "configured-creators-only", clients: [{
        ...CONFIGURED_CLIENT, access: view ? "verified" : "unavailable", observedAt: view?.observedAt ?? null,
        reportingDate: view?.reportingDate ?? null, campaign: view?.campaign ?? null, capMinor: null, actions: ACTIONS,
      }] });
    } catch (error) { next(error); }
  });

  router.all("/performance", async (req, res, next) => {
    try {
      if (!fixedGet(req, res)) return;
      const view = await observe(), campaignId = view?.campaign?.campaignId ?? null;
      const reportingDate = view?.reportingDate ?? null;
      let performance: PerformanceObservation | null = null;
      if (campaignId && reportingDate) {
        try {
          performance = verifyPerformance(await readPerformance({ campaignId, reportingDate }), reportingDate, now());
        } catch { /* Provider data is optional; do not expose errors or tokens to the browser. */ }
      }
      res.json({ schemaVersion: 1, checkedAt: now().toISOString(), clientId: CLIENT_ID, campaignId, reportingDate,
        granularity: "hour", state: performance ? "available" : view && !campaignId ? "no-active-campaign" : "unavailable",
        observedAt: performance?.observedAt ?? null, series: performance?.series ?? [] });
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
const creatorReadEnabled = () => process.env.CREATOR_READ_ENABLED === "true";
export const automationRouter = createAutomationRouter({
  viewerIds: () => process.env.CREATOR_AUTOMATION_VIEWER_USER_IDS,
  readSnapshot: () => creatorReadEnabled() ? creatorSnapshot() : Promise.resolve(null),
  readPerformance: scope => creatorReadEnabled() ? creatorPerformance(scope) : Promise.resolve(null),
});
