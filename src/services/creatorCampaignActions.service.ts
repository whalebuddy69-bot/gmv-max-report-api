import { randomUUID } from "node:crypto";
import { CampaignActionError, validRoiTenths, type CampaignAction, type CampaignActionSnapshot, type CampaignActionTarget,
  type CampaignSwitch, type createPpanCampaignActionProvider } from "./creatorCampaignActions.provider";
import type { CampaignActionRecord, createPpanCampaignActionStore } from "./creatorCampaignActions.store";
import type { WebBudgetPolicy } from "./creatorWebBudget.service";

type Mode = "disabled" | "dry-run" | "live";
export type CampaignPreviewInput = { campaignId: string; action: CampaignAction; expectedStatus: CampaignSwitch; expectedRoiTenths: number; targetRoiTenths?: number };
const changes = (x: CampaignActionSnapshot, action: CampaignAction) => x.scheduleOpen &&
  (action === "SET_ROI" || (action === "PAUSE" ? x.operationStatus === "ENABLE" : x.operationStatus === "DISABLE"));
const publicCampaign = (row: CampaignActionSnapshot) => ({ campaignId: row.campaignId, campaignName: row.campaignName,
  operationStatus: row.operationStatus, roiTargetTenths: row.roiTargetTenths, observedAt: row.observedAt });
const unready = (code: string, message: string): never => { throw new CampaignActionError(code, 409, message); };
const locked = (code: "AUTO_ACTIVE" | "WRITE_LOCKED") => unready(code, code === "AUTO_ACTIVE"
  ? "หยุด Auto ของ Ppan ก่อนส่งคำสั่งจัดการแคมเปญ" : "มีคำสั่งค้างอยู่ กรุณาตรวจผลก่อนส่งใหม่");
const WINDOW_MS = 120_000;

export function configuredPpanCampaignActionMode(action: CampaignAction, env: NodeJS.ProcessEnv = process.env): Mode {
  if (env.CREATOR_READ_ENABLED !== "true" || env.CREATOR_PPAN_CAMPAIGN_ACTIONS_MODE === "disabled") return "disabled";
  if (env.CREATOR_PPAN_CAMPAIGN_ACTIONS_MODE === "live" && env.CREATOR_BUDGET_TEST_ENABLED !== "true" &&
    env.CREATOR_PPAN_CAMPAIGN_OPERATOR_FENCE_VERIFIED === "true" &&
    (action === "SET_ROI" ? env.CREATOR_PPAN_CAMPAIGN_ROI_LIVE_VERIFIED === "true" :
      action === "PAUSE" ? env.CREATOR_PPAN_CAMPAIGN_PAUSE_LIVE_VERIFIED === "true" : env.CREATOR_PPAN_CAMPAIGN_RESUME_LIVE_VERIFIED === "true")) return "live";
  return "dry-run";
}

export function createPpanCampaignActions({ provider, store, mode, readPolicy, now = () => new Date() }:
  { provider: ReturnType<typeof createPpanCampaignActionProvider>; store: ReturnType<typeof createPpanCampaignActionStore>;
    mode: (action: CampaignAction) => Mode; readPolicy: () => Promise<WebBudgetPolicy>; now?: () => Date }) {
  const find = async (campaignId?: string) => {
    if (campaignId === undefined) return provider.find(await store.lastPausedId().catch(() => null));
    const exact = await provider.find(campaignId, { exact: true });
    return exact?.campaignId === campaignId ? exact : null;
  };
  const lookup = async (ownerId: number, operationId: string) => {
    const row = await store.get(ownerId, operationId);
    if (!row) throw new CampaignActionError("CAMPAIGN_OPERATION_NOT_FOUND", 404, "ไม่พบรายการของบัญชีนี้");
    return row;
  };
  function result(row: CampaignActionRecord) {
    const expired = Date.parse(row.expiresAt) <= now().getTime();
    const status = expired && row.status === "PROCESSING" ? "OUTCOME_UNKNOWN" : expired && row.status === "PREPARED" ? "NOT_SENT" : row.status;
    return { operationId: row.operationId, action: row.action, campaignId: row.campaignId, status,
      sent: status === "APPLIED_VERIFIED" ? true : status === "NOT_SENT" || status === "PREPARED" ? false : null };
  }
  async function withinResumeCap(campaign: CampaignActionSnapshot) {
    if (!campaign.nativeAutoOff || !campaign.scheduleOpen) return false;
    const [policy, others] = await Promise.all([readPolicy(), provider.otherSpend(campaign.campaignId)]);
    return !policy.locked && Number.isSafeInteger(others) && others >= 0 && campaign.budgetMinor <= policy.campaignCapMinor &&
      BigInt(campaign.budgetMinor) + BigInt(others) <= BigInt(policy.clientDailyCapMinor);
  }
  return {
    async status(campaignId?: string) {
      const actionModes = { setRoi: mode("SET_ROI"), pause: mode("PAUSE"), resume: mode("RESUME") };
      const modes = Object.values(actionModes);
      const overall: Mode = modes.includes("live") ? "live" : modes.includes("dry-run") ? "dry-run" : "disabled";
      const disabled = { clientId: "punpan_020" as const, mode: overall, actionModes, campaign: null, capabilities: { setRoi: false, pause: false, resume: false, create: false } };
      if (overall === "disabled") return { ...disabled, blocker: "MODE_DISABLED" };
      try {
        const row = await find(campaignId);
        if (!row) return { ...disabled, blocker: "NO_EXACT_CAMPAIGN" };
        const blocker = overall === "live" ? await store.findBlocker() : null;
        const allowed = (a: CampaignAction, actionMode: Mode) => changes(row, a) && actionMode !== "disabled" &&
          (actionMode !== "live" || (blocker === null && (a !== "RESUME" || campaignId === undefined || row.nativeAutoOff)));
        return { ...disabled, campaign: publicCampaign(row), blocker,
          capabilities: { setRoi: allowed("SET_ROI", actionModes.setRoi), pause: allowed("PAUSE", actionModes.pause),
            resume: allowed("RESUME", actionModes.resume), create: false } };
      } catch (e) { return { ...disabled, blocker: e instanceof CampaignActionError && e.code === "MULTIPLE_ACTIVE_CAMPAIGNS" ? e.code : "CAMPAIGN_UNAVAILABLE" }; }
    },
    async preview(ownerId: number, input: CampaignPreviewInput) {
      const actionMode = mode(input.action);
      if (actionMode === "disabled") return unready("MODE_DISABLED", "ยังไม่ได้เปิดเครื่องมือจัดการแคมเปญ");
      const row = await find(input.campaignId);
      if (!row || row.campaignId !== input.campaignId || row.operationStatus !== input.expectedStatus || row.roiTargetTenths !== input.expectedRoiTenths) {
        return unready("CAMPAIGN_BASELINE_CHANGED", "แคมเปญหรือข้อมูลล่าสุดเปลี่ยน กรุณาเปิดใหม่และตรวจอีกครั้ง");
      }
      if (!changes(row, input.action)) return unready("CAMPAIGN_ACTION_NOT_AVAILABLE", "สถานะหรือช่วงเวลาของแคมเปญไม่รองรับคำสั่งนี้");
      const before: CampaignActionTarget = { status: row.operationStatus, roiTenths: row.roiTargetTenths };
      let after: CampaignActionTarget;
      if (input.action === "SET_ROI") {
        if (!validRoiTenths(input.targetRoiTenths) || input.targetRoiTenths === before.roiTenths) return unready("ROI_INVALID", "กรอก ROI ใหม่เป็นเลขบวกทศนิยมไม่เกินหนึ่งตำแหน่ง");
        after = { ...before, roiTenths: input.targetRoiTenths };
      } else after = { ...before, status: input.action === "PAUSE" ? "DISABLE" : "ENABLE" };
      const view = { sent: false as const, action: input.action, campaignId: row.campaignId, before, after, mode: actionMode };
      if (actionMode === "dry-run") return view;
      const blocked = await store.findBlocker();
      if (blocked) return locked(blocked);
      if (input.action === "RESUME" && !await withinResumeCap(row)) return unready("RESUME_CAP_OR_NATIVE_AUTO_UNVERIFIED", "ยังยืนยันเพดานงบหรือการปิด Auto Budget ของ TikTok ไม่ได้");
      const operationId = randomUUID(), expiresAt = new Date(now().getTime() + WINDOW_MS).toISOString();
      await store.create({ operationId, ownerId, action: input.action, campaignId: row.campaignId, before, after, fingerprint: row.fingerprint, expiresAt });
      return { ...view, operationId, expiresAt };
    },
    async operation(ownerId: number, operationId: string) { return result(await lookup(ownerId, operationId)); },
    async confirm(ownerId: number, operationId: string, recheckOperator: () => Promise<boolean>) {
      const existing = await lookup(ownerId, operationId);
      if (existing.status !== "PREPARED") return result(existing);
      if (mode(existing.action) !== "live" || !await recheckOperator() || Date.parse(existing.expiresAt) <= now().getTime()) {
        return unready("CAMPAIGN_CONFIRM_EXPIRED_OR_DISABLED", "หมดเวลา หรือสิทธิ์เปลี่ยน กรุณาตรวจใหม่");
      }
      const row = await store.reserve(ownerId, operationId);
      if (!row) {
        const latest = await lookup(ownerId, operationId);
        if (latest.status !== "PREPARED") return result(latest);
        return locked(await store.findBlocker() ?? "WRITE_LOCKED");
      }
      // Once PROCESSING is committed, a crash or ambiguous send never clears this fence automatically.
      let dispatched = false;
      let outcome: Awaited<ReturnType<typeof provider.send>> = "NOT_SENT";
      try {
        const exact = await find(row.campaignId);
        const valid = (x: CampaignActionSnapshot | null): x is CampaignActionSnapshot => !!x && x.campaignId === row.campaignId &&
          x.fingerprint === row.fingerprint && x.operationStatus === row.before.status && x.roiTargetTenths === row.before.roiTenths && changes(x, row.action);
        if (valid(exact)) {
          dispatched = true;
          outcome = await provider.send(exact, row.action, row.after, async () => {
            if (mode(row.action) !== "live" || Date.parse(row.expiresAt) <= now().getTime()) return false;
            if (row.action === "RESUME") {
              const latest = await find(row.campaignId);
              if (!valid(latest) || !await withinResumeCap(latest)) return false;
            }
            return mode(row.action) === "live" && await recheckOperator() && await store.canDispatch(ownerId, operationId);
          });
        }
      } catch { outcome = dispatched ? "OUTCOME_UNKNOWN" : "NOT_SENT"; }
      return result(await store.finish(ownerId, operationId, outcome));
    },
  };
}
