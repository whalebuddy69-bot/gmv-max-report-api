import { AppDataSource } from "../db/dataSource";
import { loadCreatorToken } from "../routes/creatorRead.route";
import { createPpanCampaignActionsRouter } from "../routes/creatorCampaignActions.route";
import { createPpanCampaignActionProvider } from "./creatorCampaignActions.provider";
import { configuredPpanCampaignActionMode, createPpanCampaignActions } from "./creatorCampaignActions.service";
import { createPpanCampaignActionStore } from "./creatorCampaignActions.store";
import { createCreatorWebBudgetAdapters } from "./creatorWebBudget.adapters";

export function createPpanCampaignActionsRuntime() {
  const store = createPpanCampaignActionStore(AppDataSource);
  const provider = createPpanCampaignActionProvider({ loadToken: loadCreatorToken });
  const policy = createCreatorWebBudgetAdapters({ loadToken: loadCreatorToken });
  let ready = false;
  const service = createPpanCampaignActions({ store, provider, readPolicy: policy.readPolicy, mode: action => {
    const configured = configuredPpanCampaignActionMode(action);
    return configured === "live" && !ready ? "dry-run" : configured;
  } });
  return { router: createPpanCampaignActionsRouter({ service,
    viewerIds: () => process.env.CREATOR_AUTOMATION_VIEWER_USER_IDS,
    operatorIds: () => process.env.CREATOR_AUTOMATION_OPERATOR_USER_IDS }),
  async initialize() {
    if (process.env.CREATOR_READ_ENABLED !== "true") return;
    try { await store.ensureSchema(); ready = true; } catch { ready = false; }
  } };
}
