import { AppDataSource } from "../db/dataSource";
import { createExtraCreatorTokenLoader, loadCreatorToken } from "../routes/creatorRead.route";
import { createCreatorWebBudgetRouter } from "../routes/creatorWebBudget.route";
import { createCreatorWebBudgetAdapters, createCreatorWebCapAdapters } from "./creatorWebBudget.adapters";
import { createCreatorWebBudgetService, WebBudgetMode } from "./creatorWebBudget.service";
import { createCreatorWebBudgetStore } from "./creatorWebBudget.store";
import { parseExtraAutomationClients, parseVerifiedAutomationBindings } from "./creatorAutomationRegistry.service";
import { createCreatorAutoBudgetGrantStore, type CreatorAutoBudgetClientId } from "./creatorAutoBudget.policy";
import { createCreatorAutoBudgetService } from "./creatorAutoBudget.service";
import { createCreatorReader, createExtraCreatorReader } from "./creatorRead.service";
import { parseAutomationViewerIds } from "../routes/automation.route";
import { User } from "../entities/User";

export function configuredCreatorWebBudgetMode(env: NodeJS.ProcessEnv = process.env, clientId: "punpan_020" | "srihiw" = "punpan_020"): WebBudgetMode {
  if (env.CREATOR_READ_ENABLED !== "true") return "disabled";
  const wanted = clientId === "srihiw" ? env.CREATOR_WEB_SRIHIW_BUDGET_MODE : env.CREATOR_WEB_BUDGET_MODE;
  if (wanted === "dry-run") return "dry-run";
  if (wanted === "live" && env.CREATOR_WEB_BUDGET_LIVE_ENABLED === "true" && env.CREATOR_BUDGET_TEST_ENABLED !== "true" &&
    (clientId === "punpan_020" || env.CREATOR_WEB_SRIHIW_BUDGET_LIVE_ENABLED === "true")) return "live";
  return "disabled";
}

export function configuredCreatorAutoBudgetMode(env: NodeJS.ProcessEnv = process.env, clientId: CreatorAutoBudgetClientId = "punpan_020") {
  if (env.CREATOR_READ_ENABLED !== "true") return "disabled";
  const wanted = clientId === "srihiw" ? env.CREATOR_AUTO_BUDGET_SRIHIW_MODE : env.CREATOR_AUTO_BUDGET_MODE;
  if (wanted === "shadow") return "shadow";
  if (wanted === "live" && env.CREATOR_AUTO_BUDGET_LIVE_ENABLED === "true" &&
    (clientId !== "srihiw" || env.CREATOR_AUTO_BUDGET_SRIHIW_LIVE_ENABLED === "true") &&
    configuredCreatorWebBudgetMode(env, clientId) === "live") return "live";
  return "disabled";
}

export function createCreatorWebBudgetRuntime() {
  let ledgerReady = false, srihiwLedgerReady = false, autoLedgerReady = false;
  const store = createCreatorWebBudgetStore(AppDataSource);
  const adapters = createCreatorWebBudgetAdapters({ loadToken: loadCreatorToken });
  const service = createCreatorWebBudgetService({ store, adapters,
    mode: () => ledgerReady ? configuredCreatorWebBudgetMode() : "disabled" });
  const metadata = parseExtraAutomationClients(process.env.CREATOR_AUTOMATION_EXTRA_READ_CLIENTS);
  const srihiw = parseVerifiedAutomationBindings(process.env.CREATOR_AUTOMATION_VERIFIED_READ_BINDINGS, metadata).find(row => row.clientId === "srihiw");
  const srihiwStore = srihiw && createCreatorWebBudgetStore(AppDataSource, "srihiw");
  const srihiwToken = srihiw && createExtraCreatorTokenLoader(srihiw.advertiserId);
  const srihiwAdapters = srihiw && srihiwToken && createCreatorWebBudgetAdapters({ extraBinding: srihiw, loadToken: srihiwToken });
  const srihiwService = srihiwStore && srihiwAdapters ? createCreatorWebBudgetService({ clientId: "srihiw", store: srihiwStore,
    adapters: srihiwAdapters,
    mode: () => srihiwLedgerReady ? configuredCreatorWebBudgetMode(process.env, "srihiw") : "disabled" }) : undefined;
  const grants = createCreatorAutoBudgetGrantStore(AppDataSource);
  const ppanSnapshot = createCreatorReader({ loadToken: loadCreatorToken });
  const srihiwSnapshot = srihiw && srihiwToken && createExtraCreatorReader({ loadToken: srihiwToken }, "srihiw", srihiw);
  const viewerIds = () => process.env.CREATOR_AUTOMATION_VIEWER_USER_IDS;
  const operatorIds = () => process.env.CREATOR_AUTOMATION_OPERATOR_USER_IDS;
  async function recheckOwner(id: number, authorizedAt: string) {
    const allowed = () => parseAutomationViewerIds(viewerIds()).has(id) && parseAutomationViewerIds(operatorIds()).has(id);
    if (!allowed()) return false;
    const user = await AppDataSource.getRepository(User).findOne({ where: { id }, select: { id: true, isActive: true, passwordChangedAt: true } });
    return user?.isActive === true && user.passwordChangedAt instanceof Date && user.passwordChangedAt.getTime() <= Date.parse(authorizedAt) && allowed();
  }
  const autoService = createCreatorAutoBudgetService({ clientId: "punpan_020", grants, writer: service, ledger: store, adapters, recheckOwner,
    mode: () => autoLedgerReady && ledgerReady ? configuredCreatorAutoBudgetMode() : "disabled",
    discover: async () => (await ppanSnapshot()).campaign?.campaignId ?? null });
  const srihiwAutoService = srihiwSnapshot && srihiwService && srihiwStore && srihiwAdapters ? createCreatorAutoBudgetService({ clientId: "srihiw", grants,
    writer: srihiwService, ledger: srihiwStore, adapters: srihiwAdapters, recheckOwner,
    mode: () => autoLedgerReady && srihiwLedgerReady ? configuredCreatorAutoBudgetMode(process.env, "srihiw") : "disabled",
    discover: async () => (await srihiwSnapshot()).campaign?.campaignId ?? null }) : undefined;
  const router = createCreatorWebBudgetRouter({ service, srihiwService, capEditor: createCreatorWebCapAdapters(),
    autoService, srihiwAutoService,
    extraCapConfigured: () => process.env.CREATOR_READ_ENABLED === "true" && !!srihiw,
    viewerIds, operatorIds });
  return {
    router,
    async initialize(): Promise<boolean> {
      const init = async (ledger: typeof store | undefined, clientId: "punpan_020" | "srihiw") => {
        if (!ledger || configuredCreatorWebBudgetMode(process.env, clientId) === "disabled") return false;
        try { await ledger.ensureSchema(); return true; } catch { return false; }
      };
      [ledgerReady, srihiwLedgerReady] = await Promise.all([init(store, "punpan_020"), init(srihiwStore, "srihiw")]);
      if ((ledgerReady && configuredCreatorAutoBudgetMode() !== "disabled") ||
        (srihiwLedgerReady && configuredCreatorAutoBudgetMode(process.env, "srihiw") !== "disabled")) {
        try { await grants.ensureSchema(); autoLedgerReady = true; }
        catch { autoLedgerReady = false; }
        if (autoLedgerReady) setInterval(() => {
          void autoService.tick().catch(() => undefined);
          if (srihiwAutoService) void srihiwAutoService.tick().catch(() => undefined);
        }, 60_000).unref();
      }
      return ledgerReady || srihiwLedgerReady;
    },
  };
}
