import type { WebBudgetMode } from "./creatorWebBudget.service";

export const EXTRA_CREATOR_BUDGET_SCOPE_IDS = ["srihiw", "nnshop5719", "ashopbytheta", "myushop4", "bubpa_shop189", "koolkool888"] as const;
export type ExtraCreatorBudgetScope = (typeof EXTRA_CREATOR_BUDGET_SCOPE_IDS)[number];
export type CreatorBudgetScope = "punpan_020" | ExtraCreatorBudgetScope;
export const VERIFIED_ROOM_CREATOR_IDS = ["ashopbytheta", "myushop4", "bubpa_shop189", "koolkool888"] as const;
export type VerifiedRoomCreator = (typeof VERIFIED_ROOM_CREATOR_IDS)[number];
export type LegacyAutoBudgetScope = "punpan_020" | "srihiw" | "nnshop5719" | "ashopbytheta";
export type ContinuousCreatorBudgetScope = CreatorBudgetScope;
export const LIVE_ROOM_SPEND_TREND = "verified-room-spend-trend" as const;
export type ContinuousEvidence = "verified-room" | "spend-trend" | typeof LIVE_ROOM_SPEND_TREND;

export function isVerifiedRoomCreator(id: unknown): id is VerifiedRoomCreator {
  return typeof id === "string" && (VERIFIED_ROOM_CREATOR_IDS as readonly string[]).includes(id);
}

export function allowsScheduledCreatorAuto(id: unknown): id is ContinuousCreatorBudgetScope {
  return isContinuousCreatorBudgetScope(id);
}

export function isLegacyAutoBudgetScope(id: unknown): id is LegacyAutoBudgetScope {
  return id === "punpan_020" || id === "srihiw" || id === "nnshop5719" || id === "ashopbytheta";
}

export function isContinuousCreatorBudgetScope(id: unknown): id is ContinuousCreatorBudgetScope {
  return id === "punpan_020" || isExtraCreatorBudgetScope(id);
}

export function supportsContinuousEvidence(id: ContinuousCreatorBudgetScope, evidence: ContinuousEvidence) {
  if (evidence === LIVE_ROOM_SPEND_TREND) return allowsScheduledCreatorAuto(id);
  if (id === "punpan_020") return evidence === "verified-room" || evidence === "spend-trend";
  if (id === "srihiw") return evidence === "spend-trend";
  return false;
}

const SCOPES = Object.freeze({
  punpan_020: { path: "ppan", manualMode: "CREATOR_WEB_BUDGET_MODE", manualLive: null,
    autoMode: "CREATOR_AUTO_BUDGET_MODE", autoLive: null },
  srihiw: { path: "srihiw", manualMode: "CREATOR_WEB_SRIHIW_BUDGET_MODE", manualLive: "CREATOR_WEB_SRIHIW_BUDGET_LIVE_ENABLED",
    autoMode: "CREATOR_AUTO_BUDGET_SRIHIW_MODE", autoLive: "CREATOR_AUTO_BUDGET_SRIHIW_LIVE_ENABLED" },
  nnshop5719: { path: "nnshop5719", manualMode: "CREATOR_WEB_NNSHOP5719_BUDGET_MODE", manualLive: "CREATOR_WEB_NNSHOP5719_BUDGET_LIVE_ENABLED",
    autoMode: "CREATOR_AUTO_BUDGET_NNSHOP5719_MODE", autoLive: "CREATOR_AUTO_BUDGET_NNSHOP5719_LIVE_ENABLED" },
  ashopbytheta: { path: "ashopbytheta", manualMode: "CREATOR_WEB_ASHOPBYTHETA_BUDGET_MODE", manualLive: "CREATOR_WEB_ASHOPBYTHETA_BUDGET_LIVE_ENABLED",
    autoMode: "CREATOR_AUTO_BUDGET_ASHOPBYTHETA_MODE", autoLive: "CREATOR_AUTO_BUDGET_ASHOPBYTHETA_LIVE_ENABLED" },
  myushop4: { path: "myushop4", manualMode: "CREATOR_WEB_MYUSHOP4_BUDGET_MODE", manualLive: "CREATOR_WEB_MYUSHOP4_BUDGET_LIVE_ENABLED",
    autoMode: "CREATOR_AUTO_BUDGET_MYUSHOP4_MODE", autoLive: "CREATOR_AUTO_BUDGET_MYUSHOP4_LIVE_ENABLED" },
  bubpa_shop189: { path: "bubpa_shop189", manualMode: "CREATOR_WEB_BUBPA_SHOP189_BUDGET_MODE", manualLive: "CREATOR_WEB_BUBPA_SHOP189_BUDGET_LIVE_ENABLED",
    autoMode: "CREATOR_AUTO_BUDGET_BUBPA_SHOP189_MODE", autoLive: "CREATOR_AUTO_BUDGET_BUBPA_SHOP189_LIVE_ENABLED" },
  koolkool888: { path: "koolkool888", manualMode: "CREATOR_WEB_KOOLKOOL888_BUDGET_MODE", manualLive: "CREATOR_WEB_KOOLKOOL888_BUDGET_LIVE_ENABLED",
    autoMode: "CREATOR_AUTO_BUDGET_KOOLKOOL888_MODE", autoLive: "CREATOR_AUTO_BUDGET_KOOLKOOL888_LIVE_ENABLED" },
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
  if (wanted === "live" && (isVerifiedRoomCreator(clientId) || env.CREATOR_AUTO_BUDGET_LIVE_ENABLED === "true") &&
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

/** This adds a safe activation path, not a new live-write authorization. */
export function configuredCreatorScheduledAutoLive(env: NodeJS.ProcessEnv, id: CreatorBudgetScope) {
  if (!allowsScheduledCreatorAuto(id)) return false;
  if (configuredCreatorSpendTrendLive(env, id)) return true;
  // NN's new scheduler can be approved separately without enabling the
  // shared legacy one-shot switch or touching any other Creator's authority.
  if (id === "nnshop5719" && env.CREATOR_AUTO_BUDGET_NNSHOP5719_SCHEDULED_LIVE_ENABLED === "true" &&
    configuredCreatorWebBudgetMode(env, id) === "live") return true;
  if (configuredCreatorAutoBudgetMode(env, id) !== "live") return false;
  return id !== "punpan_020" || env.CREATOR_AUTO_BUDGET_PPAN_CONTINUOUS_LIVE_ENABLED === "true";
}
