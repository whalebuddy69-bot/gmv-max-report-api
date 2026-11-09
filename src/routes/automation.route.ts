import { json, Router } from "express";
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
import { createProductionLiveGmvDiscoveryScanner } from "../services/liveGmvDiscovery.service";
import { createCreatorMonitorRuntime } from "../services/creatorMonitor.runtime";
import type { CreatorMonitorCandidate } from "../services/creatorMonitorProof.service";
import { AppError } from "../utils/errors";
import { loadCreatorToken } from "./creatorRead.route";

const MAX_SNAPSHOT_AGE_MS = 30_000;
const MAX_PERFORMANCE_AGE_MS = 190_000; // 3m server cache plus bounded provider fetch allowance.
const MAX_CAMPAIGN_DAY_AGE_MS = 35_000;
const MAX_VIEWERS = 100;
const VIEWER_WINDOW_MS = 60_000;
const VIEWER_REQUEST_LIMIT = 24;
const LIVE_DISCOVERY_ORIGIN = "https://report.whalebuddy69.com";
const MAX_ENROLL_SNAPSHOT_AGE_MS = 15 * 60_000;
const DISCOVERY_ID = /^[1-9]\d{5,30}$/;
const DISCOVERY_STATES = new Set(["refreshing", "ready", "partial", "unavailable"]);
const DISCOVERY_KINDS = new Set(["creator", "shop", "unknown"]);
const DISCOVERY_DISABLED = Object.freeze({ schemaVersion: 1, state: "unavailable", checkedAt: null,
  accountsChecked: 0, accountsTotal: 0, campaigns: [] });
const ACTIONS = Object.freeze({ start: false, pause: false, increaseBudget: false, decreaseBudget: false, auto: false });

type UnknownRecord = Record<string, unknown>;
type AutomationRouteDependencies = {
  viewerIds: () => string | undefined;
  discoveryOperatorIds?: () => string | undefined;
  liveDiscovery?: { read: () => unknown; refresh: () => unknown; snapshot?: () => unknown };
  monitor?: { available(): boolean; entries(owner: number): Promise<AutomationCreatorReadEntry[]>;
    enroll(owner: number, candidate: CreatorMonitorCandidate): Promise<"created" | "existing" | "conflict" | "limit"> };
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

function discoveryLabel(value: unknown, limit: number): string | null {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, limit) || null
    : null;
}

/** Only forward the explicitly reviewed fields. No credential, actor, or write metadata. */
function verifiedLiveDiscovery(raw: unknown, now: Date) {
  if (!record(raw) || raw.schemaVersion !== 1 || typeof raw.state !== "string" || !DISCOVERY_STATES.has(raw.state) ||
    !nonnegativeInteger(raw.accountsChecked) || !nonnegativeInteger(raw.accountsTotal) || raw.accountsChecked > raw.accountsTotal ||
    !Array.isArray(raw.campaigns) || raw.campaigns.length > 2_000) return null;
  if (raw.checkedAt !== null && (typeof raw.checkedAt !== "string" || !Number.isFinite(Date.parse(raw.checkedAt)) ||
    Date.parse(raw.checkedAt) > now.getTime() + 30_000 || new Date(raw.checkedAt).toISOString() !== raw.checkedAt)) return null;
  if ((raw.state === "ready" || raw.state === "partial") && raw.checkedAt === null ||
    raw.state === "ready" && raw.accountsChecked !== raw.accountsTotal ||
    raw.campaigns.length > 0 && raw.checkedAt === null) return null;
  const seen = new Set<string>();
  const campaigns = [];
  for (const row of raw.campaigns) {
    if (!record(row) || typeof row.advertiserId !== "string" || !DISCOVERY_ID.test(row.advertiserId) ||
      typeof row.campaignId !== "string" || !DISCOVERY_ID.test(row.campaignId) ||
      (row.operationStatus !== undefined && row.operationStatus !== "ENABLE") ||
      typeof row.kind !== "string" || !DISCOVERY_KINDS.has(row.kind)) return null;
    const key = `${row.advertiserId}:${row.campaignId}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const shopId = row.kind === "shop" && typeof row.shopId === "string" && DISCOVERY_ID.test(row.shopId) ? row.shopId : null;
    campaigns.push({ advertiserId: row.advertiserId, advertiserName: discoveryLabel(row.advertiserName, 160) ?? row.advertiserId,
      campaignId: row.campaignId, campaignName: discoveryLabel(row.campaignName, 160) ?? "แคมเปญ LIVE GMV Max",
      secondaryStatus: typeof row.secondaryStatus === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(row.secondaryStatus) ? row.secondaryStatus : null,
      kind: row.kind, tiktokUsername: row.kind !== "unknown" ? verifiedTikTokUsername(row.tiktokUsername) : null,
      shopId, shopName: shopId ? discoveryLabel(row.shopName, 160) : null });
  }
  return { schemaVersion: 1, state: raw.state, checkedAt: raw.checkedAt,
    accountsChecked: raw.accountsChecked, accountsTotal: raw.accountsTotal, campaigns };
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

export function createAutomationRouter({ viewerIds, discoveryOperatorIds, liveDiscovery, monitor, readSnapshot, readPerformance, readCampaignDay, readUsername, configuredExtraClients, verifiedExtras,
  pendingReason, now = () => new Date() }: AutomationRouteDependencies) {
  const router = Router();
  let windowStart = -Infinity;
  const viewerRequests = new Map<number, number>();
  const enrollRequests = new Map<number, number>(), enrollInFlight = new Set<number>();
  const registry = () => createAutomationReadRegistry({ extraConfig: configuredExtraClients?.(),
    ppan: { readSnapshot, readPerformance, readCampaignDay, readUsername }, verifiedExtras: verifiedExtras?.(), pendingReason });
  function monitorOwner(req: Request): number | null {
    return monitor?.available() && req.user?.role === "admin" && parseAutomationViewerIds(discoveryOperatorIds?.()).has(req.user.sub)
      ? req.user.sub : null;
  }
  async function requestRegistry(req: Request): Promise<readonly AutomationCreatorReadEntry[]> {
    const base = registry(), owner = monitorOwner(req);
    if (owner === null || !monitor) return base;
    const entries = await monitor.entries(owner).catch(() => []);
    return [...base, ...entries.filter(entry => !base.some(item => item.creator.clientId === entry.creator.clientId ||
      item.creator.advertiserId === entry.creator.advertiserId))];
  }

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
    if (time < windowStart || time - windowStart >= VIEWER_WINDOW_MS) { windowStart = time; viewerRequests.clear(); enrollRequests.clear(); }
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

  // Discovery reads all app-authorized ad accounts, not just the explicitly
  // configured clients shown in the managed overview. Keep the scope separate.
  router.all(["/live-discovery", "/live-discovery/refresh"], (req, res, next) => {
    try {
      const refresh = req.path === "/live-discovery/refresh";
      if (!refresh && req.path !== "/live-discovery") {
        res.status(404).json({ error: { code: "DISCOVERY_NOT_CONFIGURED" } });
        return;
      }
      if (req.method !== (refresh ? "POST" : "GET")) {
        res.set("Allow", refresh ? "POST" : "GET").status(405).json({ error: { code: "DISCOVERY_METHOD_DENIED" } });
        return;
      }
      if (req.originalUrl.includes("?") || (refresh && (req.headers["transfer-encoding"] !== undefined ||
        (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0") ||
        req.body !== undefined && (!record(req.body) || Object.keys(req.body).length !== 0)))) {
        res.status(400).json({ error: { code: "DISCOVERY_FIXED_SCOPE" } });
        return;
      }
      if (!req.user || !parseAutomationViewerIds(discoveryOperatorIds?.()).has(req.user.sub) ||
        (refresh && req.header("origin") !== LIVE_DISCOVERY_ORIGIN)) {
        res.status(403).json({ error: { code: "DISCOVERY_ACCESS_DENIED" } });
        return;
      }
      if (!liveDiscovery) {
        res.status(404).json({ error: { code: "DISCOVERY_NOT_CONFIGURED" } });
        return;
      }
      const snapshot = verifiedLiveDiscovery(refresh ? liveDiscovery.refresh() : liveDiscovery.read(), now());
      if (!snapshot) {
        res.status(503).json({ error: { code: "DISCOVERY_UNAVAILABLE" } });
        return;
      }
      res.json({ ...snapshot, ...(monitorOwner(req) === null ? {} : { canAddCreators: true }) });
    } catch (error) { next(error); }
  });

  router.all("/live-discovery/enroll", (req, res, next) => {
    if (req.method !== "POST") { res.set("Allow", "POST").status(405).json({ error: { code: "DISCOVERY_METHOD_DENIED" } }); return; }
    if (monitorOwner(req) === null || req.header("origin") !== LIVE_DISCOVERY_ORIGIN) {
      res.status(403).json({ error: { code: "MONITOR_ACCESS_DENIED" } }); return;
    }
    if (req.originalUrl.includes("?") || !req.is("application/json")) {
      res.status(400).json({ error: { code: "MONITOR_INVALID_REQUEST" } }); return;
    }
    next();
  }, json({ limit: "1kb", inflate: false }), async (req, res) => {
    const owner = monitorOwner(req);
    if (owner === null || !monitor || !liveDiscovery) { res.status(403).json({ error: { code: "MONITOR_ACCESS_DENIED" } }); return; }
    const input: unknown = req.body;
    if (!record(input) || Object.keys(input).length !== 3 || typeof input.advertiserId !== "string" || !DISCOVERY_ID.test(input.advertiserId) ||
      typeof input.campaignId !== "string" || !DISCOVERY_ID.test(input.campaignId) || typeof input.expectedUsername !== "string" ||
      !verifiedTikTokUsername(input.expectedUsername)) { res.status(400).json({ error: { code: "MONITOR_INVALID_REQUEST" } }); return; }
    const { advertiserId, campaignId, expectedUsername } = input;
    const clientId = `mon_${advertiserId}`;
    if (registry().some(({ creator }) => creator.advertiserId === advertiserId || creator.clientId === clientId)) {
      res.status(409).json({ error: { code: "MONITOR_ALREADY_CONFIGURED" } }); return;
    }
    const checked = now();
    const discovery = verifiedLiveDiscovery(liveDiscovery.snapshot ? liveDiscovery.snapshot() : liveDiscovery.read(), checked);
    if (!discovery?.checkedAt || discovery.state === "unavailable" || checked.getTime() - Date.parse(discovery.checkedAt) > MAX_ENROLL_SNAPSHOT_AGE_MS ||
      !discovery.campaigns.some(row => row.advertiserId === advertiserId && row.campaignId === campaignId && row.kind === "creator" &&
        row.shopId === null && row.tiktokUsername === expectedUsername)) {
      res.status(409).json({ error: { code: "MONITOR_REFRESH_REQUIRED" } }); return;
    }
    if ((enrollRequests.get(owner) ?? 0) >= 4 || enrollInFlight.has(owner) || enrollInFlight.size >= 2) {
      res.set("Retry-After", "60").status(429).json({ error: { code: "MONITOR_RATE_LIMITED" } }); return;
    }
    enrollRequests.set(owner, (enrollRequests.get(owner) ?? 0) + 1);
    enrollInFlight.add(owner);
    try {
      const result = await monitor.enroll(owner, { advertiserId, campaignId, expectedUsername });
      if (result === "created" || result === "existing") res.status(result === "created" ? 201 : 200).json({ clientId, advertiserId });
      else res.status(409).json({ error: { code: result === "limit" ? "MONITOR_LIMIT" : "MONITOR_IDENTITY_CONFLICT" } });
    } catch { res.status(503).json({ error: { code: "MONITOR_VERIFICATION_UNAVAILABLE" } }); }
    finally { enrollInFlight.delete(owner); }
  });

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
      const clients = await Promise.all((await requestRegistry(req)).map(async entry => {
        const [{ view, accessReason }, tiktokUsername] = await Promise.all([observe(entry),
          Promise.resolve().then(() => entry.adapter?.readUsername?.()).then(verifiedTikTokUsername).catch(() => null)]);
        return { ...entry.creator, tiktokAccountIdVerified: entry.creator.clientId === PPAN_AUTOMATION_CREATOR.clientId ||
          ("monitoringOnly" in entry.creator && entry.creator.tiktokAccountId !== null),
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
      const entry = validAutomationClientId(clientId) ? (await requestRegistry(req)).find(candidate => candidate.creator.clientId === clientId) : undefined;
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
      const entry = validAutomationClientId(clientId) ? (await requestRegistry(req)).find(candidate => candidate.creator.clientId === clientId) : undefined;
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
    if ((error as { type?: string } | null)?.type === "entity.too.large" || (error as { type?: string } | null)?.type === "entity.parse.failed") {
      res.status(400).json({ error: { code: "MONITOR_INVALID_REQUEST" } }); return;
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
const liveGmvDiscovery = createProductionLiveGmvDiscoveryScanner();
const creatorMonitor = createCreatorMonitorRuntime(advertiserId => liveGmvDiscovery.credentialSourceFor(advertiserId));
export const initializeCreatorMonitor = () => creatorMonitor.initialize();
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
  discoveryOperatorIds: () => process.env.CREATOR_AUTOMATION_OPERATOR_USER_IDS,
  liveDiscovery: {
    read: () => creatorReadEnabled() ? liveGmvDiscovery.read() : DISCOVERY_DISABLED,
    refresh: () => creatorReadEnabled() ? liveGmvDiscovery.refresh() : DISCOVERY_DISABLED,
    snapshot: () => creatorReadEnabled() ? liveGmvDiscovery.snapshot() : DISCOVERY_DISABLED,
  },
  monitor: creatorMonitor,
  configuredExtraClients,
  verifiedExtras: verifiedExtraAdapters,
  pendingReason: () => !creatorReadEnabled() ? "upstream-unavailable"
    : configuredVerifiedBindings() ? "identity-unverified" : "needs-authorization",
  readSnapshot: () => creatorReadEnabled() ? creatorSnapshot() : Promise.resolve(null),
  readPerformance: scope => creatorReadEnabled() ? creatorPerformance(scope) : Promise.resolve(null),
  readCampaignDay: () => creatorReadEnabled() ? creatorCampaignDay() : Promise.resolve(null),
  readUsername: () => creatorReadEnabled() ? creatorUsername() : Promise.resolve(null),
});
