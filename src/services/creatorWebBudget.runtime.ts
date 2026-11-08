import { AppDataSource } from "../db/dataSource";
import { createExtraCreatorTokenLoader, loadCreatorToken } from "../routes/creatorRead.route";
import { createCreatorWebBudgetRouter, type ScopedCreatorBudgetServices } from "../routes/creatorWebBudget.route";
import { createCreatorWebBudgetAdapters, createCreatorWebCapAdapters, readPpanAutoLineStatus } from "./creatorWebBudget.adapters";
import { createCreatorWebBudgetService } from "./creatorWebBudget.service";
import { createCreatorWebBudgetStore } from "./creatorWebBudget.store";
import { parseExtraAutomationClients, parseVerifiedAutomationBindings } from "./creatorAutomationRegistry.service";
import { createCreatorAutoBudgetGrantStore } from "./creatorAutoBudget.policy";
import { createCreatorAutoBudgetService } from "./creatorAutoBudget.service";
import { createCreatorContinuousAutoBudgetService } from "./creatorContinuousAutoBudget.service";
import { createCreatorContinuousAutoBudgetStore } from "./creatorContinuousAutoBudget.store";
import { createPpanAutoObservabilityStore } from "./ppanAutoObservability.store";
import { createPpanAutoWatchRouter } from "../routes/ppanAutoWatch.route";
import { bangkokDay, createCreatorReader, createExtraCreatorReader } from "./creatorRead.service";
import { parseAutomationViewerIds } from "../routes/automation.route";
import { User } from "../entities/User";
import { configuredCreatorAutoBudgetMode, configuredCreatorWebBudgetMode, configuredPpanSpendTrendLive, configuredCreatorSpendTrendLive,
  isExtraCreatorBudgetScope, type CreatorBudgetScope } from "./creatorBudgetScope";
export { configuredCreatorAutoBudgetMode, configuredCreatorWebBudgetMode } from "./creatorBudgetScope";

export function createCreatorWebBudgetRuntime() {
  const ledgerReady = new Set<CreatorBudgetScope>();
  const continuousReady = new Set<"punpan_020"|"srihiw">();
  let autoLedgerReady = false, timer: ReturnType<typeof setInterval> | undefined;
  const grants = createCreatorAutoBudgetGrantStore(AppDataSource);
  const sessions = createCreatorContinuousAutoBudgetStore(AppDataSource);
  const diagnostics = createPpanAutoObservabilityStore(AppDataSource);
  const lineConfirmed = new Set<string>();
  let diagnosticsReady = false;
  const viewerIds = () => process.env.CREATOR_AUTOMATION_VIEWER_USER_IDS;
  const operatorIds = () => process.env.CREATOR_AUTOMATION_OPERATOR_USER_IDS;
  async function recheckOwner(id: number, authorizedAt: string) {
    const allowed = () => parseAutomationViewerIds(viewerIds()).has(id) && parseAutomationViewerIds(operatorIds()).has(id);
    if (!allowed()) return false;
    const user = await AppDataSource.getRepository(User).findOne({ where: { id }, select: { id: true, isActive: true, passwordChangedAt: true } });
    return user?.isActive === true && user.passwordChangedAt instanceof Date && user.passwordChangedAt.getTime() <= Date.parse(authorizedAt) && allowed();
  }
  function makeRuntime(clientId: CreatorBudgetScope, adapters: ReturnType<typeof createCreatorWebBudgetAdapters>,
    reader: ReturnType<typeof createCreatorReader>) {
    const store = createCreatorWebBudgetStore(AppDataSource, clientId);
    const service = createCreatorWebBudgetService({ clientId, store, adapters,
      mode: () => ledgerReady.has(clientId) ? configuredCreatorWebBudgetMode(process.env, clientId) : "disabled" });
    const autoService = createCreatorAutoBudgetService({ clientId, grants, writer: service, ledger: store, adapters, recheckOwner,
      mode: () => autoLedgerReady && ledgerReady.has(clientId) ? (clientId === "punpan_020" || clientId === "srihiw" ? "shadow" : configuredCreatorAutoBudgetMode(process.env, clientId)) : "disabled",
      discover: async () => (await reader()).campaign?.campaignId ?? null });
    return { clientId, store, service, autoService };
  }
  const ppanReader = createCreatorReader({ loadToken: loadCreatorToken });
  const ppanAdapters = createCreatorWebBudgetAdapters({ loadToken: loadCreatorToken });
  const ppan = makeRuntime("punpan_020", ppanAdapters, ppanReader);
  const continuousAutoService = createCreatorContinuousAutoBudgetService({ sessions, writer: ppan.service, ledger: ppan.store,
    observeTick: event => diagnosticsReady ? diagnostics.recordTick(event) : Promise.resolve(),
    adapters: ppanAdapters, recheckOwner, evidenceMode: () => configuredPpanSpendTrendLive() ? "spend-trend" : "verified-room", mode: () => {
      if (!continuousReady.has("punpan_020") || !ledgerReady.has("punpan_020")) return "disabled";
      if (configuredPpanSpendTrendLive()) return "live";
      const configured = configuredCreatorAutoBudgetMode();
      return configured === "live" && process.env.CREATOR_AUTO_BUDGET_PPAN_CONTINUOUS_LIVE_ENABLED !== "true" ? "shadow" : configured;
    }, discover: async () => (await ppanReader()).campaign?.campaignId ?? null,
    legacyBusy: () => legacyBusy("punpan_020") });
  async function legacyBusy(clientId: "punpan_020"|"srihiw") {
    if (!autoLedgerReady) return true;
    const at = new Date();
    const rows = await Promise.all([bangkokDay(at), bangkokDay(new Date(at.getTime() - 86_400_000))].map(day => grants.get(clientId, day)));
    return rows.some(row => !!row && ((row.status === "ARMED" && Date.parse(row.expiresAt) > at.getTime()) ||
      (!!row.operationId && !row.settledAt)));
  }
  const continuousScopes = [{ id: "punpan_020" as "punpan_020"|"srihiw", store: sessions, service: continuousAutoService }];
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
    if (clientId === "srihiw") {
      const srihiwSessions = createCreatorContinuousAutoBudgetStore(AppDataSource, "srihiw");
      const srihiwAuto = createCreatorContinuousAutoBudgetService({ clientId, sessions: srihiwSessions,
        writer: runtime.service, ledger: runtime.store, adapters, recheckOwner, evidenceMode: () => "spend-trend",
        mode: () => !continuousReady.has(clientId) || !ledgerReady.has(clientId) ? "disabled" :
          configuredCreatorSpendTrendLive(process.env, clientId) ? "live" : configuredCreatorAutoBudgetMode(process.env, clientId) === "shadow" ? "shadow" : "disabled",
        discover: async () => (await reader()).campaign?.campaignId ?? null, legacyBusy: () => legacyBusy(clientId) });
      continuousScopes.push({ id: clientId, store: srihiwSessions, service: srihiwAuto });
      extraScopes[clientId] = { ...runtime, continuousAutoService: srihiwAuto };
    } else extraScopes[clientId] = runtime;
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
      key: () => process.env.CREATOR_READ_BRIDGE_KEY ?? "", snapshot: () => diagnostics.watchState() }),
    async initialize(): Promise<boolean> {
      await Promise.all(allRuntimes.map(async ({ clientId, store }) => {
        // Even with all Ppan write/read switches off, a previous continuous
        // session still needs a durable Stop and notification reconciliation.
        if (clientId !== "punpan_020" && clientId !== "srihiw" && configuredCreatorWebBudgetMode(process.env, clientId) === "disabled" && configuredCreatorAutoBudgetMode(process.env, clientId) === "disabled") return;
        try { await store.ensureSchema(); ledgerReady.add(clientId); }
        catch { ledgerReady.delete(clientId); }
      }));
      if (continuousScopes.some(({id}) => configuredCreatorSpendTrendLive(process.env, id)) || allRuntimes.some(({ clientId }) => ledgerReady.has(clientId) && configuredCreatorAutoBudgetMode(process.env, clientId) !== "disabled")) {
        try { await grants.ensureSchema(); autoLedgerReady = true; }
        catch { autoLedgerReady = false; }
      }
      for (const {id, store} of continuousScopes) {
        if (!ledgerReady.has(id)) continue;
        try { await store.ensureSchema(); continuousReady.add(id); } catch { continuousReady.delete(id); }
      }
      if (continuousReady.has("punpan_020")) {
        try { await diagnostics.ensureSchema(); diagnosticsReady = true; } catch { diagnosticsReady = false; }
      }
      if ((autoLedgerReady || continuousReady.size > 0) && !timer) timer = setInterval(() => {
        for (const { autoService } of allRuntimes) void autoService.tick().catch(() => undefined);
        for (const {id, service} of continuousScopes) if (continuousReady.has(id)) void service.tick().catch(() => undefined);
      }, 60_000).unref();
      return ledgerReady.size > 0;
    },
  };
}
