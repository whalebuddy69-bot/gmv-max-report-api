import { AppDataSource } from "../db/dataSource";
import { loadCreatorToken } from "../routes/creatorRead.route";
import { createCreatorWebBudgetRouter } from "../routes/creatorWebBudget.route";
import { createCreatorWebBudgetAdapters } from "./creatorWebBudget.adapters";
import { createCreatorWebBudgetService, WebBudgetMode } from "./creatorWebBudget.service";
import { createCreatorWebBudgetStore } from "./creatorWebBudget.store";

export function configuredCreatorWebBudgetMode(env: NodeJS.ProcessEnv = process.env): WebBudgetMode {
  if (env.CREATOR_READ_ENABLED !== "true") return "disabled";
  if (env.CREATOR_WEB_BUDGET_MODE === "dry-run") return "dry-run";
  if (env.CREATOR_WEB_BUDGET_MODE === "live" && env.CREATOR_WEB_BUDGET_LIVE_ENABLED === "true"
    && env.CREATOR_BUDGET_TEST_ENABLED !== "true") return "live";
  return "disabled";
}

export function createCreatorWebBudgetRuntime() {
  let ledgerReady = false;
  const store = createCreatorWebBudgetStore(AppDataSource);
  const adapters = createCreatorWebBudgetAdapters({ loadToken: loadCreatorToken });
  const service = createCreatorWebBudgetService({ store, adapters,
    mode: () => ledgerReady ? configuredCreatorWebBudgetMode() : "disabled" });
  const router = createCreatorWebBudgetRouter({ service, viewerIds: () => process.env.CREATOR_AUTOMATION_VIEWER_USER_IDS,
    operatorIds: () => process.env.CREATOR_AUTOMATION_OPERATOR_USER_IDS });
  return {
    router,
    async initialize(): Promise<boolean> {
      if (configuredCreatorWebBudgetMode() === "disabled") return false;
      try { await store.ensureSchema(); ledgerReady = true; return true; }
      catch { ledgerReady = false; return false; }
    },
  };
}
