import { AppDataSource } from "../db/dataSource";
import { createExtraCreatorTokenLoader, loadCreatorToken } from "../routes/creatorRead.route";
import { createCreatorWebBudgetRouter, type ScopedCreatorBudgetServices } from "../routes/creatorWebBudget.route";
import { createCreatorWebBudgetAdapters, createCreatorWebCapAdapters } from "./creatorWebBudget.adapters";
import { createCreatorWebBudgetService } from "./creatorWebBudget.service";
import { createCreatorWebBudgetStore } from "./creatorWebBudget.store";
import { parseExtraAutomationClients, parseVerifiedAutomationBindings } from "./creatorAutomationRegistry.service";
import { createCreatorAutoBudgetGrantStore } from "./creatorAutoBudget.policy";
import { createCreatorAutoBudgetService } from "./creatorAutoBudget.service";
import { createCreatorContinuousAutoBudgetService } from "./creatorContinuousAutoBudget.service";
import { createCreatorContinuousAutoBudgetStore } from "./creatorContinuousAutoBudget.store";
import { bangkokDay, createCreatorReader, createExtraCreatorReader } from "./creatorRead.service";
import { parseAutomationViewerIds } from "../routes/automation.route";
import { User } from "../entities/User";
import { configuredCreatorAutoBudgetMode, configuredCreatorWebBudgetMode,
  isExtraCreatorBudgetScope, type CreatorBudgetScope } from "./creatorBudgetScope";
export { configuredCreatorAutoBudgetMode, configuredCreatorWebBudgetMode } from "./creatorBudgetScope";

export function createCreatorWebBudgetRuntime() {
  const ledgerReady = new Set<CreatorBudgetScope>();
  let autoLedgerReady = false, continuousReady = false, timer: ReturnType<typeof setInterval> | undefined;
  const grants = createCreatorAutoBudgetGrantStore(AppDataSource);
  const sessions = createCreatorContinuousAutoBudgetStore(AppDataSource);
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
      mode: () => autoLedgerReady && ledgerReady.has(clientId) ? (clientId === "punpan_020" ? "shadow" : configuredCreatorAutoBudgetMode(process.env, clientId)) : "disabled",
      discover: async () => (await reader()).campaign?.campaignId ?? null });
    return { clientId, store, service, autoService };
  }
  const ppanReader = createCreatorReader({ loadToken: loadCreatorToken });
  const ppanAdapters = createCreatorWebBudgetAdapters({ loadToken: loadCreatorToken });
  const ppan = makeRuntime("punpan_020", ppanAdapters, ppanReader);
  const continuousAutoService = createCreatorContinuousAutoBudgetService({ sessions, writer: ppan.service, ledger: ppan.store,
    adapters: ppanAdapters, recheckOwner, mode: () => {
      if (!continuousReady || !ledgerReady.has("punpan_020")) return "disabled";
      const configured = configuredCreatorAutoBudgetMode();
      return configured === "live" && process.env.CREATOR_AUTO_BUDGET_PPAN_CONTINUOUS_LIVE_ENABLED !== "true" ? "shadow" : configured;
    }, discover: async () => (await ppanReader()).campaign?.campaignId ?? null,
    legacyBusy: async () => {
      if (!autoLedgerReady) return true;
      const at = new Date();
      const rows = await Promise.all([bangkokDay(at), bangkokDay(new Date(at.getTime() - 86_400_000))].map(day => grants.get("punpan_020", day)));
      return rows.some(row => !!row && ((row.status === "ARMED" && Date.parse(row.expiresAt) > at.getTime()) ||
        (!!row.operationId && !row.settledAt)));
    } });
  const allRuntimes = [ppan];
  const extraScopes: ScopedCreatorBudgetServices = {};
  const metadata = parseExtraAutomationClients(process.env.CREATOR_AUTOMATION_EXTRA_READ_CLIENTS);
  for (const binding of parseVerifiedAutomationBindings(process.env.CREATOR_AUTOMATION_VERIFIED_READ_BINDINGS, metadata)) {
    const clientId = binding.clientId;
    if (!isExtraCreatorBudgetScope(clientId)) continue;
    const loadToken = createExtraCreatorTokenLoader(binding.advertiserId);
    const runtime = makeRuntime(clientId, createCreatorWebBudgetAdapters({ extraBinding: binding, loadToken }),
      createExtraCreatorReader({ loadToken }, clientId, binding));
    allRuntimes.push(runtime);
    extraScopes[clientId] = runtime;
  }
  const router = createCreatorWebBudgetRouter({ service: ppan.service, autoService: ppan.autoService, continuousAutoService,
    capEditor: createCreatorWebCapAdapters(), extraScopes,
    extraConfigured: () => process.env.CREATOR_READ_ENABLED === "true",
    viewerIds, operatorIds });
  return {
    router,
    async initialize(): Promise<boolean> {
      await Promise.all(allRuntimes.map(async ({ clientId, store }) => {
        // Even with all Ppan write/read switches off, a previous continuous
        // session still needs a durable Stop and notification reconciliation.
        if (clientId !== "punpan_020" && configuredCreatorWebBudgetMode(process.env, clientId) === "disabled" && configuredCreatorAutoBudgetMode(process.env, clientId) === "disabled") return;
        try { await store.ensureSchema(); ledgerReady.add(clientId); }
        catch { ledgerReady.delete(clientId); }
      }));
      if (allRuntimes.some(({ clientId }) => ledgerReady.has(clientId) && configuredCreatorAutoBudgetMode(process.env, clientId) !== "disabled")) {
        try { await grants.ensureSchema(); autoLedgerReady = true; }
        catch { autoLedgerReady = false; }
      }
      if (ledgerReady.has("punpan_020")) {
        try { await sessions.ensureSchema(); continuousReady = true; } catch { continuousReady = false; }
      }
      if ((autoLedgerReady || continuousReady) && !timer) timer = setInterval(() => {
        for (const { autoService } of allRuntimes) void autoService.tick().catch(() => undefined);
        if (continuousReady) void continuousAutoService.tick().catch(() => undefined);
      }, 60_000).unref();
      return ledgerReady.size > 0;
    },
  };
}
