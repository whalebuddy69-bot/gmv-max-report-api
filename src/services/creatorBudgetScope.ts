import type { WebBudgetMode } from "./creatorWebBudget.service";

export const EXTRA_CREATOR_BUDGET_SCOPE_IDS = ["srihiw", "nnshop5719", "ashopbytheta"] as const;
export type ExtraCreatorBudgetScope = (typeof EXTRA_CREATOR_BUDGET_SCOPE_IDS)[number];
export type CreatorBudgetScope = "punpan_020" | ExtraCreatorBudgetScope;

const SCOPES = Object.freeze({
  punpan_020: { path: "ppan", manualMode: "CREATOR_WEB_BUDGET_MODE", manualLive: null,
    autoMode: "CREATOR_AUTO_BUDGET_MODE", autoLive: null },
  srihiw: { path: "srihiw", manualMode: "CREATOR_WEB_SRIHIW_BUDGET_MODE", manualLive: "CREATOR_WEB_SRIHIW_BUDGET_LIVE_ENABLED",
    autoMode: "CREATOR_AUTO_BUDGET_SRIHIW_MODE", autoLive: "CREATOR_AUTO_BUDGET_SRIHIW_LIVE_ENABLED" },
  nnshop5719: { path: "nnshop5719", manualMode: "CREATOR_WEB_NNSHOP5719_BUDGET_MODE", manualLive: "CREATOR_WEB_NNSHOP5719_BUDGET_LIVE_ENABLED",
    autoMode: "CREATOR_AUTO_BUDGET_NNSHOP5719_MODE", autoLive: "CREATOR_AUTO_BUDGET_NNSHOP5719_LIVE_ENABLED" },
  ashopbytheta: { path: "ashopbytheta", manualMode: "CREATOR_WEB_ASHOPBYTHETA_BUDGET_MODE", manualLive: "CREATOR_WEB_ASHOPBYTHETA_BUDGET_LIVE_ENABLED",
    autoMode: "CREATOR_AUTO_BUDGET_ASHOPBYTHETA_MODE", autoLive: "CREATOR_AUTO_BUDGET_ASHOPBYTHETA_LIVE_ENABLED" },
} as const);

export function isExtraCreatorBudgetScope(id: unknown): id is ExtraCreatorBudgetScope {
  return typeof id === "string" && (EXTRA_CREATOR_BUDGET_SCOPE_IDS as readonly string[]).includes(id);
}

function scope(id: unknown) {
  return id === "punpan_020" || isExtraCreatorBudgetScope(id) ? SCOPES[id] : null;
}

export function creatorBudgetPolicyPath(id: CreatorBudgetScope): string | null {
  const exact = scope(id);
  return exact && `/${exact.path}/policy`;
}

export function configuredCreatorWebBudgetMode(env: NodeJS.ProcessEnv = process.env, clientId: CreatorBudgetScope = "punpan_020"): WebBudgetMode {
  const exact = scope(clientId);
  if (!exact || env.CREATOR_READ_ENABLED !== "true") return "disabled";
  const wanted = env[exact.manualMode];
  if (wanted === "dry-run") return "dry-run";
  if (wanted === "live" && env.CREATOR_WEB_BUDGET_LIVE_ENABLED === "true" && env.CREATOR_BUDGET_TEST_ENABLED !== "true" &&
    (exact.manualLive === null || env[exact.manualLive] === "true")) return "live";
  return "disabled";
}

export function configuredCreatorAutoBudgetMode(env: NodeJS.ProcessEnv = process.env, clientId: CreatorBudgetScope = "punpan_020") {
  const exact = scope(clientId);
  if (!exact || env.CREATOR_READ_ENABLED !== "true") return "disabled";
  const wanted = env[exact.autoMode];
  if (wanted === "shadow") return "shadow";
  if (wanted === "live" && env.CREATOR_AUTO_BUDGET_LIVE_ENABLED === "true" &&
    (exact.autoLive === null || env[exact.autoLive] === "true") && configuredCreatorWebBudgetMode(env, clientId) === "live") return "live";
  return "disabled";
}

// Independent from the shared Auto live switch, which must not enable other Creators for Ppan's policy.
export function configuredPpanSpendTrendLive(env: NodeJS.ProcessEnv = process.env) {
  return configuredCreatorSpendTrendLive(env, "punpan_020");
}

export function configuredCreatorSpendTrendLive(env: NodeJS.ProcessEnv = process.env, clientId: CreatorBudgetScope = "punpan_020") {
  const flag = clientId === "punpan_020" ? "CREATOR_AUTO_BUDGET_PPAN_SPEND_TREND_LIVE_ENABLED" :
    clientId === "srihiw" ? "CREATOR_AUTO_BUDGET_SRIHIW_SPEND_TREND_LIVE_ENABLED" : null;
  return flag !== null && env[flag] === "true" && configuredCreatorWebBudgetMode(env, clientId) === "live";
}
