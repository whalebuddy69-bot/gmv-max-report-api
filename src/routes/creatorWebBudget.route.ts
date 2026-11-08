import express, { ErrorRequestHandler, Request, RequestHandler, Router } from "express";
import { requireAuth } from "../middleware/auth";
import { loadSessionUser, verifyToken } from "../services/auth.service";
import {
  createCreatorWebBudgetService, WEB_BUDGET_CAMPAIGN_ID, WEB_BUDGET_OPERATION_ID, WebBudgetError,
} from "../services/creatorWebBudget.service";
import { AppError } from "../utils/errors";
import { parseAutomationViewerIds } from "./automation.route";
import type { createCreatorWebCapAdapters } from "../services/creatorWebBudget.adapters";
import type { createCreatorAutoBudgetService } from "../services/creatorAutoBudget.service";
import type { createCreatorContinuousAutoBudgetService } from "../services/creatorContinuousAutoBudget.service";
import { EXTRA_CREATOR_BUDGET_SCOPE_IDS, isExtraCreatorBudgetScope, type ExtraCreatorBudgetScope } from "../services/creatorBudgetScope";

export const CREATOR_WEB_BUDGET_ORIGIN = "https://report.whalebuddy69.com";
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i;
const BOUNDARY_MS = 60_000, READ_LIMIT = 48, POST_LIMIT = 12;
const safeAmount = (input: unknown): input is number => typeof input === "number" && Number.isSafeInteger(input) && input > 0;
function fields(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function badInput(): never { throw new WebBudgetError("BUDGET_INPUT_INVALID", 400, "ข้อมูลคำสั่งไม่ถูกต้อง"); }

type BudgetService = ReturnType<typeof createCreatorWebBudgetService>;
type AutoService = ReturnType<typeof createCreatorAutoBudgetService>;
export type ScopedCreatorBudgetServices = Partial<Record<ExtraCreatorBudgetScope, { service: BudgetService; autoService?: AutoService }>>;

export function createCreatorWebBudgetRouter({ viewerIds, operatorIds, service, capEditor, autoService, continuousAutoService, extraScopes = {}, extraConfigured = () => true, now = Date.now }: {
  viewerIds: () => string | undefined; operatorIds: () => string | undefined;
  capEditor?: ReturnType<typeof createCreatorWebCapAdapters>; extraConfigured?: (clientId: ExtraCreatorBudgetScope) => boolean;
  extraScopes?: ScopedCreatorBudgetServices; autoService?: AutoService;
  continuousAutoService?: ReturnType<typeof createCreatorContinuousAutoBudgetService>;
  service: BudgetService; now?: () => number;
}) {
  const router = Router({ caseSensitive: true, strict: true });
  const windows = new Map<number, { read: number; post: number }>();
  let windowStart = -Infinity;
  const canOperate = (id: number) => parseAutomationViewerIds(viewerIds()).has(id) && parseAutomationViewerIds(operatorIds()).has(id);
  async function recheck(req: Request, id: number): Promise<boolean> {
    try {
      const header = req.header("authorization") ?? "";
      const [scheme, token] = header.split(" ");
      if (scheme?.toLowerCase() !== "bearer" || !token || !canOperate(id)) return false;
      const payload = verifyToken(token);
      if (payload.sub !== id) return false;
      await loadSessionUser(payload);
      return canOperate(id);
    } catch { return false; }
  }
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store").vary("Authorization").vary("Origin");
    if (req.originalUrl.includes("?")) { res.status(400).json({ error: { code: "BUDGET_FIXED_SCOPE", message: "ไม่รองรับ query สำหรับคำสั่งงบ" } }); return; }
    if (req.method === "POST" && req.header("origin") !== CREATOR_WEB_BUDGET_ORIGIN) {
      res.status(403).json({ error: { code: "BUDGET_ORIGIN_DENIED", message: "คำสั่งนี้ใช้ได้จากหน้า Automation เท่านั้น" } }); return;
    }
    next();
  });
  router.use(requireAuth);
  router.use((req, res, next) => {
    const owner = req.user?.sub;
    const viewers = parseAutomationViewerIds(viewerIds());
    if (owner === undefined || !viewers.has(owner)) {
      res.status(403).json({ error: { code: "AUTOMATION_ACCESS_DENIED", message: "บัญชีนี้ยังไม่ได้รับสิทธิ์ Automation" } }); return;
    }
    const time = now();
    if (time < windowStart || time - windowStart >= BOUNDARY_MS) { windows.clear(); windowStart = time; }
    for (const id of windows.keys()) if (!viewers.has(id)) windows.delete(id);
    const budget = windows.get(owner) ?? { read: 0, post: 0 };
    const key = req.method === "POST" ? "post" : "read";
    if (budget[key] >= (key === "post" ? POST_LIMIT : READ_LIMIT)) {
      res.set("Retry-After", "60").status(429).json({ error: { code: "BUDGET_RATE_LIMITED", message: "รอสักครู่ก่อนทำรายการใหม่" } }); return;
    }
    budget[key]++; windows.set(owner, budget);
    next();
  });
  const onlyOperator: RequestHandler = (req, res, next) => {
    if (req.user && canOperate(req.user.sub)) { next(); return; }
    res.status(403).json({ error: { code: "BUDGET_OPERATOR_DENIED", message: "บัญชีนี้ยังไม่ได้รับสิทธิ์สั่งงบ" } });
  };
  const onlyJson: RequestHandler = (req, res, next) => {
    const type = req.header("content-type") ?? "", encoding = req.header("content-encoding");
    if (!JSON_TYPE.test(type) || (encoding !== undefined && encoding.toLowerCase() !== "identity")) {
      res.status(415).json({ error: { code: "BUDGET_JSON_REQUIRED", message: "ต้องส่งข้อมูล JSON" } }); return;
    }
    next();
  };
  const json = express.json({ limit: 2048, strict: true, inflate: false });
  const handle = (fn: (req: Request, ownerId: number) => Promise<unknown>): RequestHandler => async (req, res, next) => {
    try { res.json(await fn(req, req.user!.sub)); } catch (error) { next(error); }
  };
  const get: RequestHandler = (req, res, next) => {
    if (req.method === "GET") { next(); return; }
    res.set("Allow", "GET").status(405).json({ error: { code: "BUDGET_METHOD_DENIED", message: "ไม่รองรับวิธีเรียกนี้" } });
  };
  const scopedPaths = (path: string) => [path, ...EXTRA_CREATOR_BUDGET_SCOPE_IDS.map(id => `/${id}${path}`)];
  const configuredExtra = (id: ExtraCreatorBudgetScope) => extraConfigured(id) && Object.prototype.hasOwnProperty.call(extraScopes, id) ? extraScopes[id] : undefined;
  const firstSegment = (req: Request) => req.path.split("/")[1];
  function serviceFor(req: Request) {
    const id = firstSegment(req);
    if (!isExtraCreatorBudgetScope(id)) return service;
    const scoped = configuredExtra(id);
    if (!scoped) throw new WebBudgetError("BUDGET_ROUTE_NOT_FOUND", 404, "ไม่พบหน้าคำสั่งนี้");
    return scoped.service;
  }
  router.get(scopedPaths("/status"), get, handle((req, id) => serviceFor(req).status(canOperate(id))));
  router.get(scopedPaths("/operations/:operationId"), get, onlyOperator, handle((req, id) => {
    if (typeof req.params.operationId !== "string" || !WEB_BUDGET_OPERATION_ID.test(req.params.operationId)) badInput();
    return serviceFor(req).operation(id, req.params.operationId);
  }));
  router.post(scopedPaths("/prepare"), onlyOperator, onlyJson, json, handle((req, id) => {
    const value: unknown = req.body;
    if (!fields(value, ["expectedCampaignId", "expectedBudgetMinor", "targetBudgetMinor"])
      || typeof value.expectedCampaignId !== "string" || !WEB_BUDGET_CAMPAIGN_ID.test(value.expectedCampaignId)
      || !safeAmount(value.expectedBudgetMinor) || !safeAmount(value.targetBudgetMinor)) badInput();
    return serviceFor(req).prepare(id, { expectedCampaignId: value.expectedCampaignId, expectedBudgetMinor: value.expectedBudgetMinor,
      targetBudgetMinor: value.targetBudgetMinor });
  }));
  router.post(scopedPaths("/confirm"), onlyOperator, onlyJson, json, handle((req, id) => {
    const value: unknown = req.body;
    if (!fields(value, ["operationId", "nativeAutoOff", "noConcurrentChanges"])
      || typeof value.operationId !== "string" || !WEB_BUDGET_OPERATION_ID.test(value.operationId)
      || value.nativeAutoOff !== true || value.noConcurrentChanges !== true) badInput();
    return serviceFor(req).confirm(id, { operationId: value.operationId, nativeAutoOff: true, noConcurrentChanges: true }, () => recheck(req, id));
  }));
  function autoFor(req: Request) {
    const id = firstSegment(req);
    const scoped = isExtraCreatorBudgetScope(id) ? configuredExtra(id)?.autoService : autoService;
    if (!scoped) throw new WebBudgetError("AUTO_BUDGET_NOT_CONFIGURED", 404, "ยังไม่ได้ตั้งค่า Auto สำหรับ Creator นี้");
    return scoped;
  }
  const continuousFor = (req: Request) => !isExtraCreatorBudgetScope(firstSegment(req)) ? continuousAutoService : undefined;
  router.get(scopedPaths("/auto/status"), get, handle((req, id) => (continuousFor(req) ?? autoFor(req)).status(canOperate(id), id)));
  router.post(scopedPaths("/auto/arm"), onlyOperator, onlyJson, json, handle((req, id) => {
    const value: unknown = req.body;
    const continuous = continuousFor(req);
    const base = ["expectedCampaignId", "expectedBudgetMinor", "expectedPolicyRevision"];
    if (continuous && fields(value, [...base, "evidenceMode"]) && value.evidenceMode === "spend-trend") {
      if (typeof value.expectedCampaignId !== "string" || !WEB_BUDGET_CAMPAIGN_ID.test(value.expectedCampaignId)
        || !safeAmount(value.expectedBudgetMinor) || !safeAmount(value.expectedPolicyRevision)) badInput();
      return continuous.arm(id, { expectedCampaignId: value.expectedCampaignId, expectedBudgetMinor: value.expectedBudgetMinor,
        expectedPolicyRevision: value.expectedPolicyRevision, evidenceMode: "spend-trend" }, () => recheck(req, id));
    }
    const exact = [...base, "nativeAutoOff", "noConcurrentChanges"];
    if (!fields(value, continuous ? [...exact, "expectedLiveSessionId"] : [...exact, "durationMinutes"])
      || typeof value.expectedCampaignId !== "string" || !WEB_BUDGET_CAMPAIGN_ID.test(value.expectedCampaignId)
      || !safeAmount(value.expectedBudgetMinor) || !safeAmount(value.expectedPolicyRevision)
      || value.nativeAutoOff !== true || value.noConcurrentChanges !== true) badInput();
    const input = { expectedCampaignId: value.expectedCampaignId, expectedBudgetMinor: value.expectedBudgetMinor,
      expectedPolicyRevision: value.expectedPolicyRevision, nativeAutoOff: true as const, noConcurrentChanges: true as const };
    if (continuous) {
      if (typeof value.expectedLiveSessionId !== "string" || !WEB_BUDGET_CAMPAIGN_ID.test(value.expectedLiveSessionId)) badInput();
      return continuous.arm(id, { ...input, expectedLiveSessionId: value.expectedLiveSessionId }, () => recheck(req, id));
    }
    if (!safeAmount(value.durationMinutes)) badInput();
    return autoFor(req).arm(id, { ...input, durationMinutes: value.durationMinutes }, () => recheck(req, id));
  }));
  router.post(scopedPaths("/auto/stop"), onlyOperator, onlyJson, json, handle(async (req, id) => {
    const value: unknown = req.body;
    const continuous = continuousFor(req);
    if (continuous && fields(value, ["sessionId"])) {
      if (typeof value.sessionId !== "string" || !WEB_BUDGET_OPERATION_ID.test(value.sessionId)) badInput();
      if (!await recheck(req, id)) throw new WebBudgetError("BUDGET_OPERATOR_DENIED", 403, "บัญชีนี้ยังไม่ได้รับสิทธิ์สั่งงบ");
      return continuous.stop(id, value.sessionId);
    }
    if (!fields(value, ["grantId"]) || typeof value.grantId !== "string" || !WEB_BUDGET_OPERATION_ID.test(value.grantId)) badInput();
    if (!await recheck(req, id)) throw new WebBudgetError("BUDGET_OPERATOR_DENIED", 403, "บัญชีนี้ยังไม่ได้รับสิทธิ์สั่งงบ");
    return autoFor(req).stop(id, value.grantId);
  }));
  const extraCapPaths = EXTRA_CREATOR_BUDGET_SCOPE_IDS.map(id => `/cap/${id}`);
  const capPaths = ["/cap", ...extraCapPaths];
  const capMissing = () => new WebBudgetError("CAP_NOT_CONFIGURED", 404, "ไม่พบการตั้งเพดานของ Creator นี้");
  function extraCapClient(req: Request) {
    const id = req.path.split("/")[2];
    if (!isExtraCreatorBudgetScope(id) || !configuredExtra(id)) throw capMissing();
    return id;
  }
  router.get(extraCapPaths, get, handle(async (req, id) => {
    if (!capEditor) throw capMissing();
    const clientId = extraCapClient(req);
    const state = await capEditor.status(clientId);
    return { clientId, cap: state.cap, capEditAllowed: canOperate(id) && state.capEditAllowed };
  }));
  router.post(capPaths, onlyOperator, onlyJson, json, handle((req, id) => {
    const clientId = req.path === "/cap" ? "punpan_020" : extraCapClient(req);
    if (!capEditor) throw capMissing();
    const value: unknown = req.body;
    if (!fields(value, ["expectedRevision", "capMinor"]) || typeof value.expectedRevision !== "number" ||
      !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < (clientId === "punpan_020" ? 1 : 0) ||
      !safeAmount(value.capMinor)) badInput();
    return capEditor.update(clientId, id, value.expectedRevision, value.capMinor, () => recheck(req, id));
  }));
  router.all(capPaths, (req, res) => {
    res.set("Allow", req.path === "/cap" ? "POST" : "GET, POST")
      .status(405).json({ error: { code: "BUDGET_METHOD_DENIED", message: "ไม่รองรับวิธีเรียกนี้" } });
  });
  router.all(["/status", "/operations/:operationId", "/prepare", "/confirm", "/auto/status", "/auto/arm", "/auto/stop"].flatMap(scopedPaths), (req, res) => {
    res.set("Allow", /\/(?:prepare|confirm|arm|stop)$/.test(req.path) ? "POST" : "GET")
      .status(405).json({ error: { code: "BUDGET_METHOD_DENIED", message: "ไม่รองรับวิธีเรียกนี้" } });
  });
  router.use((_req, res) => res.status(404).json({ error: { code: "BUDGET_ROUTE_NOT_FOUND", message: "ไม่พบหน้าคำสั่งนี้" } }));
  const safeError: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) { next(error); return; }
    if (error instanceof WebBudgetError) { res.status(error.httpStatus).json({ error: { code: error.code, message: error.message } }); return; }
    if (error instanceof AppError && error.httpStatus === 401) {
      res.status(401).json({ error: { code: "AUTH_FAILED", message: "กรุณาเข้าสู่ระบบใหม่" } }); return;
    }
    if (error?.type === "entity.parse.failed" || error?.status === 400) {
      res.status(400).json({ error: { code: "BUDGET_INPUT_INVALID", message: "ข้อมูลคำสั่งไม่ถูกต้อง" } }); return;
    }
    if (error?.type === "entity.too.large") {
      res.status(413).json({ error: { code: "BUDGET_BODY_TOO_LARGE", message: "ข้อมูลคำสั่งใหญ่เกินไป" } }); return;
    }
    res.status(503).json({ error: { code: "BUDGET_WORKFLOW_UNAVAILABLE", message: "ยังยืนยันสถานะรายการไม่ได้ กรุณาตรวจสอบก่อนส่งใหม่" } });
  };
  router.use(safeError);
  return router;
}
