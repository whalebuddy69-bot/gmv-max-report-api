import { CREATOR_BINDING } from "./creatorRead.service";

const MAX_EXTRAS = 8;
const MAX_RAW_LENGTH = 4_096;
const SAFE_CLIENT_ID = /^[a-z][a-z0-9_-]{1,39}$/;
const TIKTOK_ID = /^[1-9]\d{5,30}$/;
const IDENTITY_ID = /^[A-Za-z0-9_-]{6,100}$/;
const SAFE_DISPLAY_NAME = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} _.-]{0,59}$/u;
const METADATA_FIELDS = ["clientId", "displayName", "advertiserId", "tiktokAccountId"] as const;
const VERIFIED_FIELDS = ["clientId", "advertiserId", "tiktokAccountId", "identityId", "identityType", "identityAuthorizedBcId"] as const;

export type AutomationAccessReason = "needs-authorization" | "identity-unverified" | "upstream-unavailable";
export type AutomationCreator = Readonly<{
  clientId: string;
  displayName: string;
  advertiserId: string;
  tiktokAccountId: string;
}>;
export type AutomationCreatorBinding = Readonly<{
  advertiserId: string;
  tiktokAccountId: string;
  identityId: string;
  identityType: string;
  identityAuthorizedBcId: string;
}>;
export type AutomationVerifiedCreatorBinding = AutomationCreatorBinding & Readonly<{
  clientId: string;
  identityType: "BC_AUTH_TT";
}>;
export type AutomationPerformanceScope = { campaignId: string; reportingDate: string };
export type AutomationCreatorReadAdapter = Readonly<{
  clientId: string;
  binding: AutomationCreatorBinding;
  readSnapshot: () => Promise<unknown>;
  readPerformance: (scope: AutomationPerformanceScope) => Promise<unknown>;
  readCampaignDay?: () => Promise<unknown>;
}>;
export type AutomationCreatorReadEntry = Readonly<{
  creator: AutomationCreator;
  adapter: AutomationCreatorReadAdapter | null;
  accessReason: AutomationAccessReason;
}>;

export const PPAN_AUTOMATION_CREATOR: AutomationCreator = Object.freeze({
  clientId: "punpan_020", displayName: "Ppan", advertiserId: CREATOR_BINDING.advertiserId,
  tiktokAccountId: CREATOR_BINDING.tiktokAccountId,
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validAutomationClientId(value: unknown): value is string {
  return typeof value === "string" && SAFE_CLIENT_ID.test(value);
}

function validTikTokId(value: unknown): value is string {
  return typeof value === "string" && TIKTOK_ID.test(value);
}

function exactFields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length
    && keys.every(field => Object.prototype.hasOwnProperty.call(value, field));
}

/** Server-owned metadata only; malformed or conflicting config never grants partial access. */
export function parseExtraAutomationClients(raw: string | undefined): readonly AutomationCreator[] {
  if (!raw || raw.length > MAX_RAW_LENGTH) return [];
  let input: unknown;
  try { input = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(input) || input.length > MAX_EXTRAS) return [];
  const slugs = new Set([PPAN_AUTOMATION_CREATOR.clientId]);
  const advertisers = new Set([PPAN_AUTOMATION_CREATOR.advertiserId]);
  const accounts = new Set([PPAN_AUTOMATION_CREATOR.tiktokAccountId]);
  const creators: AutomationCreator[] = [];
  for (const value of input) {
    if (!exactFields(value, METADATA_FIELDS)) return [];
    const { clientId, displayName, advertiserId, tiktokAccountId } = value;
    if (!validAutomationClientId(clientId) || slugs.has(clientId)
      || typeof displayName !== "string" || displayName.trim() !== displayName || !SAFE_DISPLAY_NAME.test(displayName)
      || !validTikTokId(advertiserId) || advertisers.has(advertiserId)
      || !validTikTokId(tiktokAccountId) || accounts.has(tiktokAccountId)) return [];
    slugs.add(clientId); advertisers.add(advertiserId); accounts.add(tiktokAccountId);
    creators.push(Object.freeze({ clientId, displayName, advertiserId, tiktokAccountId }));
  }
  return Object.freeze(creators);
}

/** Explicit server-only evidence is separate from the dashboard metadata registry. */
export function parseVerifiedAutomationBindings(raw: string | undefined, configured: readonly AutomationCreator[]): readonly AutomationVerifiedCreatorBinding[] {
  if (!raw || raw.length > MAX_RAW_LENGTH) return [];
  let input: unknown;
  try { input = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(input) || input.length > MAX_EXTRAS || input.length > configured.length) return [];
  const bySlug = new Map(configured.map(creator => [creator.clientId, creator]));
  const slugs = new Set([PPAN_AUTOMATION_CREATOR.clientId]);
  const identities = new Set<string>([CREATOR_BINDING.identityId]);
  const bindings: AutomationVerifiedCreatorBinding[] = [];
  for (const value of input) {
    if (!exactFields(value, VERIFIED_FIELDS)) return [];
    const { clientId, advertiserId, tiktokAccountId, identityId, identityType, identityAuthorizedBcId } = value;
    if (!validAutomationClientId(clientId) || slugs.has(clientId)
      || !validTikTokId(advertiserId) || !validTikTokId(tiktokAccountId)
      || typeof identityId !== "string" || !IDENTITY_ID.test(identityId) || identities.has(identityId)
      || identityType !== "BC_AUTH_TT" || !validTikTokId(identityAuthorizedBcId)) return [];
    const creator = bySlug.get(clientId);
    if (!creator || creator.advertiserId !== advertiserId || creator.tiktokAccountId !== tiktokAccountId) return [];
    slugs.add(clientId); identities.add(identityId);
    bindings.push(Object.freeze({ clientId, advertiserId, tiktokAccountId, identityId, identityType, identityAuthorizedBcId }));
  }
  return Object.freeze(bindings);
}

function adapterMatches(creator: AutomationCreator, adapter: AutomationCreatorReadAdapter): boolean {
  const binding = adapter?.binding;
  return adapter?.clientId === creator.clientId && !!binding && binding.advertiserId === creator.advertiserId
    && binding.tiktokAccountId === creator.tiktokAccountId && typeof binding.identityId === "string"
    && IDENTITY_ID.test(binding.identityId) && binding.identityType === "BC_AUTH_TT"
    && validTikTokId(binding.identityAuthorizedBcId) && typeof adapter.readSnapshot === "function"
    && typeof adapter.readPerformance === "function";
}

/** The request can select an allowlisted slug, never construct a provider adapter. */
export function createAutomationReadRegistry({ extraConfig, ppan, verifiedExtras = [], pendingReason }: {
  extraConfig?: string;
  ppan: Omit<AutomationCreatorReadAdapter, "clientId" | "binding">;
  verifiedExtras?: readonly AutomationCreatorReadAdapter[];
  pendingReason?: (creator: AutomationCreator) => AutomationAccessReason | undefined;
}): readonly AutomationCreatorReadEntry[] {
  const primary: AutomationCreatorReadEntry = {
    creator: PPAN_AUTOMATION_CREATOR,
    adapter: { clientId: PPAN_AUTOMATION_CREATOR.clientId, binding: CREATOR_BINDING,
      readSnapshot: ppan.readSnapshot, readPerformance: ppan.readPerformance, readCampaignDay: ppan.readCampaignDay },
    accessReason: "upstream-unavailable",
  };
  return [primary, ...parseExtraAutomationClients(extraConfig).map((creator): AutomationCreatorReadEntry => {
    const matching = verifiedExtras.filter(candidate => candidate?.clientId === creator.clientId);
    const adapter = matching.length === 1 && adapterMatches(creator, matching[0]) ? matching[0] : null;
    const reason = pendingReason?.(creator);
    const accessReason = adapter ? "upstream-unavailable" : matching.length > 0 ? "identity-unverified"
      : reason === "needs-authorization" || reason === "upstream-unavailable" || reason === "identity-unverified"
        ? reason : "needs-authorization";
    return { creator, adapter, accessReason };
  })];
}
