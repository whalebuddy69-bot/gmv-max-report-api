import { AppDataSource } from "../db/dataSource";
import { createExtraCreatorTokenLoader, loadCreatorToken } from "../routes/creatorRead.route";
import { createCreatorWebBudgetRouter, type ScopedCreatorBudgetServices } from "../routes/creatorWebBudget.route";
import { createCreatorWebBudgetAdapters, createCreatorWebCapAdapters, quarantineBubpaUnknownLease, queueCreatorAutoCheckFailureAlert, readPpanAutoLineStatus } from "./creatorWebBudget.adapters";
import { createCreatorBudgetRecoveryStore } from "./creatorBudgetRecovery.store";
import { createCreatorBudgetRecoveryService } from "./creatorBudgetRecovery.service";
import { createBubpaBudgetRecoveryEvidenceReader } from "./creatorBudgetRecovery.adapters";
import { createCreatorWebBudgetService, WebBudgetError } from "./creatorWebBudget.service";
import { createCreatorWebBudgetStore } from "./creatorWebBudget.store";
import { parseExtraAutomationClients, parseVerifiedAutomationBindings } from "./creatorAutomationRegistry.service";
import { createCreatorAutoBudgetGrantStore } from "./creatorAutoBudget.policy";
import { createCreatorAutoBudgetService } from "./creatorAutoBudget.service";
import { createCreatorContinuousAutoBudgetService, type CreatorAutoCheckObservation } from "./creatorContinuousAutoBudget.service";
import { createCreatorContinuousAutoBudgetStore } from "./creatorContinuousAutoBudget.store";
import { createCreatorAutoCheckHealthStore } from "./creatorAutoCheckHealth.store";
import { verifiedCreatorAutoAlertIdentity } from "./creatorAutoAdvertiserName.service";
import { createPpanAutoObservabilityStore } from "./ppanAutoObservability.store";
import { createPpanAutoWatchRouter } from "../routes/ppanAutoWatch.route";
import { bangkokDay, CREATOR_BINDING, createCreatorReader, createExtraCreatorReader } from "./creatorRead.service";
import { parseAutomationViewerIds } from "../routes/automation.route";
import { User } from "../entities/User";
import { configuredCreatorAutoBudgetMode, configuredCreatorScheduledAutoLive, configuredCreatorWebBudgetMode, configuredPpanSpendTrendLive, configuredCreatorSpendTrendLive,
  isExtraCreatorBudgetScope, isLegacyAutoBudgetScope, isVerifiedRoomCreator,
  LIVE_ROOM_SPEND_TREND,
  type ContinuousCreatorBudgetScope, type CreatorBudgetScope } from "./creatorBudgetScope";
export { configuredCreatorAutoBudgetMode, configuredCreatorWebBudgetMode } from "./creatorBudgetScope";

export function createCreatorWebBudgetRuntime() {
  const ledgerReady = new Set<CreatorBudgetScope>();
  const continuousReady = new Set<ContinuousCreatorBudgetScope>();
  let autoLedgerReady = false, timer: ReturnType<typeof setInterval> | undefined;
  const grants = createCreatorAutoBudgetGrantStore(AppDataSource);
  const sessions = createCreatorContinuousAutoBudgetStore(AppDataSource);
  const diagnostics = createPpanAutoObservabilityStore(AppDataSource);
  const checkHealth = createCreatorAutoCheckHealthStore(AppDataSource);
  const recoveryStore = createCreatorBudgetRecoveryStore(AppDataSource);
  let recoveryReady = false;
  const lineConfirmed = new Set<string>();
  let diagnosticsReady = false, checkHealthReady = false;
  const viewerIds = () => process.env.CREATOR_AUTOMATION_VIEWER_USER_IDS;
  const operatorIds = () => process.env.CREATOR_AUTOMATION_OPERATOR_USER_IDS;
  async function recheckOwner(id: number, authorizedAt: string) {
    const allowed = () => parseAutomationViewerIds(viewerIds()).has(id) && parseAutomationViewerIds(operatorIds()).has(id);
    if (!allowed()) return false;
    const user = await AppDataSource.getRepository(User).findOne({ where: { id }, select: { id: true, isActive: true, passwordChangedAt: true } });
    return user?.isActive === true && user.passwordChangedAt instanceof Date && user.passwordChangedAt.getTime() <= Date.parse(authorizedAt) && allowed();
  }
  function observeCheckHealth(clientId: ContinuousCreatorBudgetScope, advertiserId: string) {
    const identity = verifiedCreatorAutoAlertIdentity(clientId, advertiserId);
    return async (event: CreatorAutoCheckObservation) => {
      if (!checkHealthReady || !identity) return;
      await checkHealth.record(clientId, event);
      const pending = await checkHealth.pending(clientId);
      if (!pending || pending.sessionId !== event.sessionId || !await recheckOwner(event.ownerId, event.authorizedAt)) return;
      // A lost response is retried with the same scoped ID and immutable text.
      await queueCreatorAutoCheckFailureAlert(clientId, { ...identity, incidentId: pending.incidentId });
      await checkHealth.markDelivered(clientId, pending);
    };
  }
  function makeRuntime(clientId: CreatorBudgetScope, adapters: ReturnType<typeof createCreatorWebBudgetAdapters>,
    reader: ReturnType<typeof createCreatorReader>) {
    const store = createCreatorWebBudgetStore(AppDataSource, clientId);
    const service = createCreatorWebBudgetService({ clientId, store, adapters,
      mode: () => ledgerReady.has(clientId) ? configuredCreatorWebBudgetMode(process.env, clientId) : "disabled" });
    const autoService = isLegacyAutoBudgetScope(clientId) ? createCreatorAutoBudgetService({ clientId, grants, writer: service, ledger: store, adapters, recheckOwner,
      mode: () => autoLedgerReady && ledgerReady.has(clientId) ? (clientId === "nnshop5719" ? configuredCreatorAutoBudgetMode(process.env, clientId) : "shadow") : "disabled",
      discover: async () => (await reader()).campaign?.campaignId ?? null }) : undefined;
    return { clientId, store, service, autoService };
  }
  const ppanReader = createCreatorReader({ loadToken: loadCreatorToken });
  const ppanAdapters = createCreatorWebBudgetAdapters({ loadToken: loadCreatorToken });
  const ppan = makeRuntime("punpan_020", ppanAdapters, ppanReader);
  const scheduledLive = (id: ContinuousCreatorBudgetScope) => continuousReady.has(id) && ledgerReady.has(id) && configuredCreatorScheduledAutoLive(process.env, id);
  const continuousAutoService = createCreatorContinuousAutoBudgetService({ sessions, writer: ppan.service, ledger: ppan.store,
    observeTick: event => diagnosticsReady ? diagnostics.recordTick(event) : Promise.resolve(),
    observeCheckHealth: observeCheckHealth("punpan_020", CREATOR_BINDING.advertiserId),
    adapters: ppanAdapters, recheckOwner, scheduledLive: () => scheduledLive("punpan_020"), evidenceMode: () => configuredPpanSpendTrendLive() ? "spend-trend" : "verified-room", mode: () => {
      if (!continuousReady.has("punpan_020") || !ledgerReady.has("punpan_020")) return "disabled";
      if (configuredPpanSpendTrendLive()) return "live";
      const configured = configuredCreatorAutoBudgetMode();
      return configured === "live" && process.env.CREATOR_AUTO_BUDGET_PPAN_CONTINUOUS_LIVE_ENABLED !== "true" ? "shadow" : configured;
    }, discover: async () => (await ppanReader()).campaign?.campaignId ?? null,
    legacyBusy: () => legacyBusy("punpan_020") });
  async function legacyBusy(clientId: ContinuousCreatorBudgetScope) {
    if (!isLegacyAutoBudgetScope(clientId)) return false; // no legacy grant schema or route ever included this scope
    if (!autoLedgerReady) return true;
    const at = new Date();
    const rows = await Promise.all([bangkokDay(at), bangkokDay(new Date(at.getTime() - 86_400_000))].map(day => grants.get(clientId, day)));
    return rows.some(row => !!row && ((row.status === "ARMED" && Date.parse(row.expiresAt) > at.getTime()) ||
      (!!row.operationId && !row.settledAt)));
  }
  const continuousScopes = [{ id: "punpan_020" as ContinuousCreatorBudgetScope, store: sessions, service: continuousAutoService }];
  const allRuntimes = [ppan];
  const extraScopes: ScopedCreatorBudgetServices = {};
  const metadata = parseExtraAutomationClients(process.env.CREATOR_AUTOMATION_EXTRA_READ_CLIENTS);
  for (const binding of parseVerifiedAutomationBindings(process.env.CREATOR_AUTOMATION_VERIFIED_READ_BINDINGS, metadata)) {
    const clientId = binding.clientId;
    if (!isExtraCreatorBudgetScope(clientId)) continue;
    const loadToken = createExtraCreatorTokenLoader(binding.advertiserId);
    const adapters = createCreatorWebBudgetAdapters({ extraBinding: binding, loadToken });
    const reader = createExtraCreatorReader({ loadToken }, clientId, binding);
    const runtime = makeRuntime(clientId, adapters, reader);
    allRuntimes.push(runtime);
    {
      const scopedSessions = createCreatorContinuousAutoBudgetStore(AppDataSource, clientId);
      const scopedAuto = createCreatorContinuousAutoBudgetService({ clientId, sessions: scopedSessions,
        writer: runtime.service, ledger: runtime.store, adapters, recheckOwner,
        observeCheckHealth: observeCheckHealth(clientId, binding.advertiserId),
        scheduledLive: () => scheduledLive(clientId),
        evidenceMode: () => clientId === "srihiw" ? "spend-trend" : LIVE_ROOM_SPEND_TREND,
        mode: () => {
          if (!continuousReady.has(clientId) || !ledgerReady.has(clientId)) return "disabled";
          const configured = configuredCreatorAutoBudgetMode(process.env, clientId);
          if (isVerifiedRoomCreator(clientId) || clientId === "nnshop5719") return configured;
          return configuredCreatorSpendTrendLive(process.env, clientId) ? "live" : configured === "shadow" ? "shadow" : "disabled";
        },
        discover: async () => (await reader()).campaign?.campaignId ?? null, legacyBusy: () => legacyBusy(clientId) });
      continuousScopes.push({ id: clientId, store: scopedSessions, service: scopedAuto });
      extraScopes[clientId] = { ...runtime, continuousAutoService: scopedAuto,
        ...(clientId === "bubpa_shop189" ? { recoverUnknown: (async (ownerId, request, recheck) => {
          if (!recoveryReady || process.env.CREATOR_BUDGET_BUBPA_RECOVERY_ENABLED !== "true") {
            throw new WebBudgetError("BUDGET_RECOVERY_DISABLED", 503, "การกู้คืนยังไม่พร้อม");
          }
          const authorizedAt = new Date().toISOString();
          const readEvidence = createBubpaBudgetRecoveryEvidenceReader({ binding, loadToken });
          return createCreatorBudgetRecoveryService({ store: recoveryStore,
            readEvidence: input => readEvidence(input.oldCampaignId, input.newCampaignId),
            recheckOperator: async id => id === ownerId && await recheck() && await recheckOwner(id, authorizedAt),
            releaseOldLease: input => quarantineBubpaUnknownLease(input),
          }).recover(ownerId, request);
        }) satisfies NonNullable<ScopedCreatorBudgetServices["bubpa_shop189"]>["recoverUnknown"] } : {}),
        ...(clientId === "nnshop5719" ? { activeLegacy: () => legacyBusy(clientId) } : {}) };
    }
  }
  const router = createCreatorWebBudgetRouter({ service: ppan.service, autoService: ppan.autoService, continuousAutoService,
    autoDiagnostics: async ownerId => {
      const view = await diagnostics.status(ownerId);
      const history = await Promise.all(view.history.map(async item => {
        if (item.status !== "APPLIED_VERIFIED") return item;
        if (lineConfirmed.has(item.operationId)) return { ...item, lineStatus: "ACCEPTED" as const };
        const lineStatus = await readPpanAutoLineStatus(item.operationId).catch(() => "UNKNOWN" as const);
        if (lineStatus === "ACCEPTED") {
          if (lineConfirmed.size >= 100) lineConfirmed.clear();
          lineConfirmed.add(item.operationId);
        }
        return { ...item, lineStatus };
      }));
      return { ...view, history };
    },
    capEditor: createCreatorWebCapAdapters(), extraScopes,
    extraConfigured: () => process.env.CREATOR_READ_ENABLED === "true",
    viewerIds, operatorIds });
  return {
    router,
    watchRouter: createPpanAutoWatchRouter({ enabled: () => diagnosticsReady && process.env.CREATOR_READ_ENABLED === "true",
      key: () => process.env.CREATOR_READ_BRIDGE_KEY ?? "", snapshot: () => diagnostics.watchState(checkHealthReady) }),
    async initialize(): Promise<boolean> {
      await Promise.all(allRuntimes.map(async ({ clientId, store }) => {
        // Even with all Ppan write/read switches off, a previous continuous
        // session still needs a durable Stop and notification reconciliation.
        if (clientId !== "punpan_020" && clientId !== "srihiw" && configuredCreatorWebBudgetMode(process.env, clientId) === "disabled" && configuredCreatorAutoBudgetMode(process.env, clientId) === "disabled") return;
        try { await store.ensureSchema(); ledgerReady.add(clientId); }
        catch { ledgerReady.delete(clientId); }
      }));
      if (continuousScopes.some(({id}) => configuredCreatorSpendTrendLive(process.env, id)) || allRuntimes.some(({ clientId, autoService }) => !!autoService && ledgerReady.has(clientId) && configuredCreatorAutoBudgetMode(process.env, clientId) !== "disabled")) {
        try { await grants.ensureSchema(); autoLedgerReady = true; }
        catch { autoLedgerReady = false; }
      }
      for (const {id, store} of continuousScopes) {
        if (!ledgerReady.has(id)) continue;
        try { await store.ensureSchema(); continuousReady.add(id); } catch { continuousReady.delete(id); }
      }
      if (continuousReady.has("bubpa_shop189") && process.env.CREATOR_BUDGET_BUBPA_RECOVERY_ENABLED === "true") {
        try { await recoveryStore.ensureSchema(); recoveryReady = true; } catch { recoveryReady = false; }
      }
      if (continuousReady.has("punpan_020")) {
        try { await diagnostics.ensureSchema(); diagnosticsReady = true; } catch { diagnosticsReady = false; }
      }
      if (continuousReady.size > 0) {
        try { await checkHealth.ensureSchema(); checkHealthReady = true; } catch { checkHealthReady = false; }
      }
      if ((autoLedgerReady || continuousReady.size > 0) && !timer) timer = setInterval(() => {
        for (const { autoService } of allRuntimes) void autoService?.tick().catch(() => undefined);
        for (const {id, service} of continuousScopes) if (continuousReady.has(id)) void service.tick().catch(() => undefined);
      }, 60_000).unref();
      return ledgerReady.size > 0;
    },
  };
}
