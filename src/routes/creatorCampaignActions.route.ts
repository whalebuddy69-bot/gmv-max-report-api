import express, { type ErrorRequestHandler, type Request, type RequestHandler, Router } from "express";
import { requireAuth } from "../middleware/auth";
import { loadSessionUser, verifyToken } from "../services/auth.service";
import { CampaignActionError, validRoiTenths } from "../services/creatorCampaignActions.provider";
import type { createPpanCampaignActions } from "../services/creatorCampaignActions.service";
import { WEB_BUDGET_CAMPAIGN_ID, WEB_BUDGET_OPERATION_ID } from "../services/creatorWebBudget.service";
import { AppError } from "../utils/errors";
import { parseAutomationViewerIds } from "./automation.route";
import { CREATOR_WEB_BUDGET_ORIGIN } from "./creatorWebBudget.route";

const bad = () => new CampaignActionError("CAMPAIGN_INPUT_INVALID", 400, "ข้อมูลคำสั่งจัดการแคมเปญไม่ถูกต้อง");
const obj = (x: unknown): Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : (() => { throw bad(); })();
const exact = (x: Record<string, unknown>, keys: string[]) => Object.keys(x).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(x, k));
const id = (x: unknown) => typeof x === "string" && WEB_BUDGET_OPERATION_ID.test(x);

export function createPpanCampaignActionsRouter({ service, viewerIds, operatorIds, now = Date.now }:
  { service: ReturnType<typeof createPpanCampaignActions>; viewerIds: () => string | undefined; operatorIds: () => string | undefined; now?: () => number }) {
  const router = Router({ caseSensitive: true, strict: true });
  const windows = new Map<number, { reads: number; posts: number }>();
  let windowStart = -Infinity;
  const allowed = (owner: number) => parseAutomationViewerIds(viewerIds()).has(owner) && parseAutomationViewerIds(operatorIds()).has(owner);
  const allowedSession = (req: Request, owner: number) => req.user?.role === "admin" && req.user.sub === owner && allowed(owner);
  async function recheck(req: Request, owner: number) {
    try {
      const [scheme, token] = (req.header("authorization") ?? "").split(" ");
      if (scheme.toLowerCase() !== "bearer" || !token || !allowedSession(req, owner)) return false;
      const payload = verifyToken(token);
      return payload.sub === owner && (await loadSessionUser(payload)).role === "admin" && allowed(owner);
    } catch { return false; }
  }
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store").vary("Authorization").vary("Origin");
    if (req.originalUrl.includes("?")) { res.status(400).json({ error: { code: "CAMPAIGN_FIXED_SCOPE", message: "คำสั่งนี้ไม่รองรับ query" } }); return; }
    if (req.method === "POST" && req.header("origin") !== CREATOR_WEB_BUDGET_ORIGIN) {
      res.status(403).json({ error: { code: "CAMPAIGN_ORIGIN_DENIED", message: "ใช้คำสั่งนี้จากหน้า Automation เท่านั้น" } }); return;
    }
    next();
  });
  router.use(requireAuth);
  router.use((req, res, next) => {
    const owner = req.user?.sub;
    if (owner === undefined || !allowedSession(req, owner)) {
      res.status(403).json({ error: { code: "CAMPAIGN_OPERATOR_DENIED", message: "บัญชีนี้ยังไม่ได้รับสิทธิ์จัดการแคมเปญ" } }); return;
    }
    const at = now();
    if (at < windowStart || at - windowStart >= 60_000) { windows.clear(); windowStart = at; }
    for (const user of windows.keys()) if (!allowed(user)) windows.delete(user);
    const row = windows.get(owner) ?? { reads: 0, posts: 0 };
    const key = req.method === "POST" ? "posts" : "reads";
    if (row[key] >= (key === "posts" ? 8 : 24)) {
      res.set("Retry-After", "60").status(429).json({ error: { code: "CAMPAIGN_RATE_LIMITED", message: "รอสักครู่ก่อนทำรายการใหม่" } }); return;
    }
    row[key]++; windows.set(owner, row); next();
  });
  const onlyGet: RequestHandler = (req, res, next) => {
    if (req.method === "GET") { next(); return; }
    res.set("Allow", "GET").status(405).json({ error: { code: "CAMPAIGN_METHOD_DENIED", message: "ไม่รองรับวิธีเรียกนี้" } });
  };
  const onlyJson: RequestHandler = (req, res, next) => {
    const encoding = req.header("content-encoding");
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(req.header("content-type") ?? "") ||
      (encoding !== undefined && encoding.toLowerCase() !== "identity")) {
      res.status(415).json({ error: { code: "CAMPAIGN_JSON_REQUIRED", message: "ต้องส่งข้อมูล JSON" } }); return;
    }
    next();
  };
  const json = express.json({ limit: 1024, strict: true, inflate: false });
  const handle = (fn: (req: Request, owner: number) => Promise<unknown>): RequestHandler => async (req, res, next) => {
    try { res.json(await fn(req, req.user!.sub)); } catch (error) { next(error); }
  };
  router.get("/status", onlyGet, handle(() => service.status()));
  router.post("/preview", onlyJson, json, handle((req, owner) => {
    const value = obj(req.body), a = value.action;
    if ((a !== "SET_ROI" && a !== "PAUSE" && a !== "RESUME") ||
      !exact(value, ["campaignId", "action", "expectedStatus", "expectedRoiTenths", ...(a === "SET_ROI" ? ["targetRoiTenths"] : [])]) ||
      typeof value.campaignId !== "string" || !WEB_BUDGET_CAMPAIGN_ID.test(value.campaignId) ||
      (value.expectedStatus !== "ENABLE" && value.expectedStatus !== "DISABLE") || !validRoiTenths(value.expectedRoiTenths) ||
      (a === "SET_ROI" && !validRoiTenths(value.targetRoiTenths))) throw bad();
    return service.preview(owner, { campaignId: value.campaignId, action: a, expectedStatus: value.expectedStatus,
      expectedRoiTenths: value.expectedRoiTenths, ...(typeof value.targetRoiTenths === "number" ? { targetRoiTenths: value.targetRoiTenths } : {}) });
  }));
  router.post("/confirm", onlyJson, json, handle((req, owner) => {
    const value = obj(req.body);
    if (!exact(value, ["operationId", "confirmed"]) || typeof value.operationId !== "string" || !id(value.operationId) || value.confirmed !== true) throw bad();
    return service.confirm(owner, value.operationId, () => recheck(req, owner));
  }));
  router.get("/operations/:operationId", onlyGet, handle((req, owner) => {
    if (typeof req.params.operationId !== "string" || !id(req.params.operationId)) throw bad();
    return service.operation(owner, req.params.operationId);
  }));
  router.use((_req, res) => res.status(404).json({ error: { code: "CAMPAIGN_ROUTE_NOT_FOUND", message: "ไม่พบหน้าคำสั่งนี้" } }));
  const error: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) { next(err); return; }
    if (err instanceof CampaignActionError) { res.status(err.httpStatus).json({ error: { code: err.code, message: err.message } }); return; }
    if (err instanceof AppError && err.httpStatus === 401) { res.status(401).json({ error: { code: "AUTH_FAILED", message: "กรุณาเข้าสู่ระบบใหม่" } }); return; }
    if (err?.type === "entity.too.large") { res.status(413).json({ error: { code: "CAMPAIGN_BODY_TOO_LARGE", message: "ข้อมูลคำสั่งใหญ่เกินไป" } }); return; }
    if (err?.type === "entity.parse.failed" || err?.status === 400) { res.status(400).json({ error: { code: "CAMPAIGN_INPUT_INVALID", message: "ข้อมูลคำสั่งไม่ถูกต้อง" } }); return; }
    res.status(503).json({ error: { code: "CAMPAIGN_UNAVAILABLE", message: "ยังยืนยันสถานะไม่ได้ กรุณาตรวจสอบก่อนส่งใหม่" } });
  };
  router.use(error);
  return router;
}
