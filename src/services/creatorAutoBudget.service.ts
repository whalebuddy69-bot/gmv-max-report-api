import { randomUUID } from "node:crypto";
import { bangkokDay } from "./creatorRead.service";
import {
  createCreatorAutoBudgetGrantStore, evaluateCreatorAutoBudget, previewCreatorAutoBudget,
  type CreatorAutoBudgetClientId, type CreatorAutoBudgetGrant,
} from "./creatorAutoBudget.policy";
import { createCreatorWebBudgetService, WEB_BUDGET_CAMPAIGN_ID, WebBudgetError,
  type WebBudgetAdapters, type WebBudgetContext, type WebBudgetStore } from "./creatorWebBudget.service";

type Mode = "disabled" | "shadow" | "live";
type Grants = ReturnType<typeof createCreatorAutoBudgetGrantStore>;
type Writer = ReturnType<typeof createCreatorWebBudgetService>;
type Input = { expectedCampaignId: string; expectedBudgetMinor: number; expectedPolicyRevision: number; durationMinutes: number;
  nativeAutoOff: true; noConcurrentChanges: true };

const unavailable = () => new WebBudgetError("AUTO_BUDGET_NOT_READY", 409, "ข้อมูลสำหรับเปิด Auto ยังไม่ครบ จึงยังไม่ส่งคำสั่งจริง");
const telemetry = (ctx: WebBudgetContext) => ({ ...ctx, providerSpendObservedAt: ctx.providerSpendObservedAt ?? null, deliveryVerified: ctx.deliveryVerified === true });

export function createCreatorAutoBudgetService({ clientId, mode, discover, adapters, grants, writer, ledger, recheckOwner, now = () => new Date() }: {
  clientId: CreatorAutoBudgetClientId; mode: () => Mode; discover: () => Promise<string | null>;
  adapters: WebBudgetAdapters; grants: Grants; writer: Writer; ledger: WebBudgetStore;
  recheckOwner: (id: number, authorizedAt: string) => Promise<boolean>; now?: () => Date;
}) {
  async function read(expectedCampaignId?: string) {
    const campaignId = await discover();
    if (!campaignId || (expectedCampaignId && campaignId !== expectedCampaignId)) throw unavailable();
    const [context, policy, hasUnresolvedWrite] = await Promise.all([
      adapters.readContext(campaignId), adapters.readPolicy(), ledger.hasFence(),
    ]);
    return { context: telemetry(context), policy, hasUnresolvedWrite };
  }
  function blockers(facts: Awaited<ReturnType<typeof read>>) {
    const reasons: string[] = [];
    if (facts.context.nativeAutoState !== "DISABLED") reasons.push("NATIVE_AUTO_UNVERIFIED");
    if (facts.context.providerSpendObservedAt === null) reasons.push("SPEND_WATERMARK_MISSING");
    if (!facts.context.deliveryVerified) reasons.push("LIVE_DELIVERY_UNVERIFIED");
    if (facts.policy.autoLineReady !== true) reasons.push("LINE_NOT_READY");
    if (facts.hasUnresolvedWrite || facts.policy.locked) reasons.push("WRITE_LOCKED");
    return reasons;
  }

  function draftGrant(facts: Awaited<ReturnType<typeof read>>, ownerId: number, at: Date, durationMinutes: number): CreatorAutoBudgetGrant {
    const { context, policy } = facts, day = bangkokDay(at);
    const endOfDay = Date.parse(`${day}T00:00:00+07:00`) + 86_400_000;
    return { grantId: randomUUID(), clientId, ownerId, campaignId: context.campaignId,
      reportingDate: day, policyRevision: policy.revision, expectedBudgetMinor: context.budgetMinor, fingerprint: context.fingerprint,
      authorizedAt: at.toISOString(), expiresAt: new Date(Math.min(at.getTime() + durationMinutes * 60_000, endOfDay - 1000)).toISOString(),
      nativeAutoOffAttested: true, noConcurrentChangesAttested: true };
  }

  function canArmGrant(facts: Awaited<ReturnType<typeof read>>, grant: CreatorAutoBudgetGrant, at: Date) {
    const { context, policy } = facts;
    if (blockers(facts).length) return false;
    const verdict = evaluateCreatorAutoBudget({ clientId, now: at, grant: { ...grant, status: "ARMED", operationId: null },
      ...facts, notificationReady: policy.autoLineReady === true });
    if (verdict.status === "ELIGIBLE") return true;
    if (verdict.status !== "BELOW_THRESHOLD") return false;
    const scaled = BigInt(context.budgetMinor) * 6n;
    const target = scaled / 5n;
    return scaled % 5n === 0n && target <= BigInt(policy.campaignCapMinor) &&
      target + BigInt(context.aggregateSpendMinor - context.spendMinor) <= BigInt(policy.clientDailyCapMinor);
  }

  async function status(operator: boolean, ownerId?: number) {
    const currentMode = mode(), day = bangkokDay(now());
    const grantRead = operator ? await grants.get(clientId, day).then(row => ({ row, ok: true })).catch(() => ({ row: null, ok: false })) : { row: null, ok: false };
    const { row } = grantRead;
    const ownRow = row && row.ownerId === ownerId ? row : null;
    const grant = ownRow ? { grantId: ownRow.grantId, status: ownRow.status, expiresAt: ownRow.expiresAt } : null;
    const canStop = ownRow?.status === "ARMED" || ownRow?.status === "RESERVED";
    if (currentMode === "disabled") return { clientId, mode: currentMode, grant, canArm: false, canStop, preview: null, blockers: [] };
    try {
      const facts = await read();
      const at = now(), preview = previewCreatorAutoBudget({ now: at, context: facts.context, policy: facts.policy });
      const canArm = currentMode === "live" && operator && grantRead.ok && !row && typeof ownerId === "number" &&
        bangkokDay(at) === day && canArmGrant(facts, draftGrant(facts, ownerId, at, 10), at);
      return { clientId, mode: currentMode, grant, canArm, canStop, preview: { status: preview.status, campaignId: facts.context.campaignId,
        currentBudgetMinor: facts.context.budgetMinor, spendMinor: facts.context.spendMinor, policyRevision: facts.policy.revision,
        thresholdMinor: Number((BigInt(facts.context.budgetMinor) * 8n + 9n) / 10n),
        targetBudgetMinor: preview.status === "WOULD_INCREASE" ? preview.targetBudgetMinor : null,
        projectedClientSpendMinor: preview.status === "WOULD_INCREASE" ? preview.projectedClientSpendMinor : null,
        observedAt: facts.context.observedAt }, blockers: blockers(facts) };
    } catch { return { clientId, mode: currentMode, grant, canArm: false, canStop, preview: null, blockers: ["CONTEXT_UNAVAILABLE"] }; }
  }

  async function arm(ownerId: number, input: Input, recheckOperator: () => Promise<boolean>) {
    if (mode() !== "live" || !WEB_BUDGET_CAMPAIGN_ID.test(input.expectedCampaignId) || input.nativeAutoOff !== true ||
      input.noConcurrentChanges !== true || !Number.isSafeInteger(input.durationMinutes) || input.durationMinutes < 10 || input.durationMinutes > 120) throw unavailable();
    const facts = await read(input.expectedCampaignId), at = now();
    const { context, policy } = facts;
    if (context.budgetMinor !== input.expectedBudgetMinor || policy.revision !== input.expectedPolicyRevision) throw unavailable();
    const grant = draftGrant(facts, ownerId, at, input.durationMinutes);
    if (!canArmGrant(facts, grant, at) || !await recheckOperator() || mode() !== "live") throw unavailable();
    if (!await grants.arm(grant)) throw new WebBudgetError("AUTO_BUDGET_DAILY_LIMIT", 409, "วันนี้มีรายการ Auto แล้ว ระบบจะไม่เปิดซ้ำ");
    return { grantId: grant.grantId, expiresAt: grant.expiresAt };
  }

  async function stop(ownerId: number, grantId: string) {
    return { stopped: !!await grants.cancel(clientId, bangkokDay(now()), grantId, ownerId) };
  }

  let busy = false;
  async function tick() {
    if (busy || mode() === "disabled") return;
    busy = true;
    try {
      const at = now(), row = await grants.get(clientId, bangkokDay(at));
      async function reconcile(previous: Awaited<ReturnType<Grants["get"]>>) {
        if (!previous?.operationId || previous.settledAt) return;
        // Recover the notification bridge only, never the TikTok write. The
        // immutable confirmed ledger is the authority, not the fetched budget.
        const result = await ledger.get(previous.ownerId, previous.operationId);
        if (result?.source === "auto" && result.status === "APPLIED_VERIFIED" && result.observedBudgetMinor === result.targetBudgetMinor) {
          await adapters.finishLease(previous.operationId, "APPLIED_VERIFIED");
          await grants.close(previous, previous.operationId);
        }
      }
      await reconcile(await grants.get(clientId, bangkokDay(new Date(at.getTime() - 86_400_000)))).catch(() => undefined);
      if (!row) return;
      if (row.operationId) {
        await reconcile(row);
        return;
      }
      if (mode() !== "live" || row.status !== "ARMED" || Date.parse(row.expiresAt) <= now().getTime() || !await recheckOwner(row.ownerId, row.authorizedAt)) return;
      const facts = await read(row.campaignId);
      const verdict = evaluateCreatorAutoBudget({ clientId, now: now(), grant: row, ...facts, notificationReady: facts.policy.autoLineReady === true });
      if (verdict.status !== "ELIGIBLE" || mode() !== "live") return;
      const op = await writer.prepare(row.ownerId, { expectedCampaignId: row.campaignId,
        expectedBudgetMinor: row.expectedBudgetMinor, targetBudgetMinor: verdict.targetBudgetMinor }, "auto");
      if (!await grants.reserve(row, op.operationId)) return;
      const allowed = async () => mode() === "live" && await recheckOwner(row.ownerId, row.authorizedAt) && await grants.isReserved(row, op.operationId);
      await writer.confirm(row.ownerId, { operationId: op.operationId, nativeAutoOff: true, noConcurrentChanges: true }, allowed,
        async (context, policy) => {
          const checked = evaluateCreatorAutoBudget({ clientId, now: now(), grant: row, context: telemetry(context), policy,
            hasUnresolvedWrite: false, notificationReady: policy.autoLineReady === true });
          return checked.status === "ELIGIBLE" && checked.targetBudgetMinor === verdict.targetBudgetMinor && await allowed();
        });
    } finally { busy = false; }
  }
  return { status, arm, stop, tick };
}
