import { createCreatorBudgetTestRouter } from "../routes/creatorBudgetTest.route";
import { loadCreatorToken } from "../routes/creatorRead.route";
import { AppDataSource } from "../db/dataSource";
import { createCreatorReader } from "./creatorRead.service";
import { createCreatorBudgetTestService } from "./creatorBudgetTest.service";
import { createCreatorBudgetTestStore } from "./creatorBudgetTest.store";

/** The existing report routes, cron, OAuth, and token storage stay unchanged. */
export function createCreatorBudgetTestRuntime() {
  let available = true;
  const service = createCreatorBudgetTestService({
    enabled: () => available && process.env.CREATOR_BUDGET_TEST_ENABLED === "true"
      && (process.env.CREATOR_BUDGET_TEST_KEY?.length ?? 0) >= 43
      && process.env.CREATOR_BUDGET_TEST_KEY !== process.env.CREATOR_READ_BRIDGE_KEY,
    permit: () => process.env.CREATOR_BUDGET_TEST_PERMIT,
    store: createCreatorBudgetTestStore(AppDataSource),
    // Constructing a reader for EACH preflight prevents reuse of its 10s cache.
    freshSnapshot: () => createCreatorReader({ loadToken: loadCreatorToken })(),
    loadToken: loadCreatorToken,
  });
  const router = createCreatorBudgetTestRouter({
    key: () => process.env.CREATOR_BUDGET_TEST_KEY ?? "",
    readKey: () => process.env.CREATOR_READ_BRIDGE_KEY ?? "",
    service,
  });
  return {
    router,
    async initialize(): Promise<boolean> {
      try { return await service.initialize(); }
      catch { available = false; return false; }
    },
  };
}
