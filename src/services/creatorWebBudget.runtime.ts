import { AppDataSource } from "../db/dataSource";
import { createExtraCreatorTokenLoader, loadCreatorToken } from "../routes/creatorRead.route";
import { createCreatorWebBudgetRouter } from "../routes/creatorWebBudget.route";
import { createCreatorWebBudgetAdapters, createCreatorWebCapAdapters } from "./creatorWebBudget.adapters";
import { createCreatorWebBudgetService, WebBudgetMode } from "./creatorWebBudget.service";
import { createCreatorWebBudgetStore } from "./creatorWebBudget.store";
import { parseExtraAutomationClients, parseVerifiedAutomationBindings } from "./creatorAutomationRegistry.service";

export function configuredCreatorWebBudgetMode(env: NodeJS.ProcessEnv = process.env, clientId: "punpan_020" | "srihiw" = "punpan_020"): WebBudgetMode {
  if (env.CREATOR_READ_ENABLED !== "true") return "disabled";
  const wanted = clientId === "srihiw" ? env.CREATOR_WEB_SRIHIW_BUDGET_MODE : env.CREATOR_WEB_BUDGET_MODE;
  if (wanted === "dry-run") return "dry-run";
  if (wanted === "live" && env.CREATOR_WEB_BUDGET_LIVE_ENABLED === "true" && env.CREATOR_BUDGET_TEST_ENABLED !== "true" &&
    (clientId === "punpan_020" || env.CREATOR_WEB_SRIHIW_BUDGET_LIVE_ENABLED === "true")) return "live";
  return "disabled";
}

export function createCreatorWebBudgetRuntime() {
  let ledgerReady = false, srihiwLedgerReady = false;
  const store = createCreatorWebBudgetStore(AppDataSource);
  const adapters = createCreatorWebBudgetAdapters({ loadToken: loadCreatorToken });
  const service = createCreatorWebBudgetService({ store, adapters,
    mode: () => ledgerReady ? configuredCreatorWebBudgetMode() : "disabled" });
  const metadata = parseExtraAutomationClients(process.env.CREATOR_AUTOMATION_EXTRA_READ_CLIENTS);
  const srihiw = parseVerifiedAutomationBindings(process.env.CREATOR_AUTOMATION_VERIFIED_READ_BINDINGS, metadata).find(row => row.clientId === "srihiw");
  const srihiwStore = srihiw && createCreatorWebBudgetStore(AppDataSource, "srihiw");
  const srihiwService = srihiw && srihiwStore ? createCreatorWebBudgetService({ clientId: "srihiw", store: srihiwStore,
    adapters: createCreatorWebBudgetAdapters({ extraBinding: srihiw, loadToken: createExtraCreatorTokenLoader(srihiw.advertiserId) }),
    mode: () => srihiwLedgerReady ? configuredCreatorWebBudgetMode(process.env, "srihiw") : "disabled" }) : undefined;
  const router = createCreatorWebBudgetRouter({ service, srihiwService, capEditor: createCreatorWebCapAdapters(),
    extraCapConfigured: () => process.env.CREATOR_READ_ENABLED === "true" && !!srihiw,
    viewerIds: () => process.env.CREATOR_AUTOMATION_VIEWER_USER_IDS,
    operatorIds: () => process.env.CREATOR_AUTOMATION_OPERATOR_USER_IDS });
  return {
    router,
    async initialize(): Promise<boolean> {
      const init = async (ledger: typeof store | undefined, clientId: "punpan_020" | "srihiw") => {
        if (!ledger || configuredCreatorWebBudgetMode(process.env, clientId) === "disabled") return false;
        try { await ledger.ensureSchema(); return true; } catch { return false; }
      };
      [ledgerReady, srihiwLedgerReady] = await Promise.all([init(store, "punpan_020"), init(srihiwStore, "srihiw")]);
      return ledgerReady || srihiwLedgerReady;
    },
  };
}
