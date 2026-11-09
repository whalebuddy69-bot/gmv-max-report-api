import { AppDataSource } from "../db/dataSource";
import { createExtraCreatorTokenLoader, loadCreatorToken } from "../routes/creatorRead.route";
import { type AutomationCreatorReadEntry } from "./creatorAutomationRegistry.service";
import { createExtraCreatorAutomationPerformance } from "./creatorAutomationPerformance.service";
import { createCreatorCampaignDayReader } from "./creatorCampaignDay.service";
import { createCreatorIdentityUsernameReader } from "./creatorIdentityUsername.service";
import { createCreatorMonitorProof, type CreatorMonitorCandidate } from "./creatorMonitorProof.service";
import { createCreatorMonitorStore, monitorResourceId, type CreatorMonitorRecord } from "./creatorMonitor.store";
import { CREATOR_BINDING, createMonitoredCreatorReader } from "./creatorRead.service";
import { verifyLiveDiscoveryGrant } from "./liveGmvDiscovery.service";

const cacheLimit = 96;
function makeTokenLoader(advertiserId: string, credentialAdvertiserId: string) {
  const load = credentialAdvertiserId === CREATOR_BINDING.advertiserId ? loadCreatorToken : createExtraCreatorTokenLoader(credentialAdvertiserId);
  if (advertiserId === credentialAdvertiserId) return load;
  let accepted: { token: string; until: number } | undefined;
  let inFlight: Promise<string> | undefined;
  return async () => {
    if (!inFlight) inFlight = (async () => {
      const token = await load();
      if (accepted?.token === token && Date.now() < accepted.until) return token;
      await verifyLiveDiscoveryGrant(advertiserId, token);
      accepted = { token, until: Date.now() + 30_000 };
      return token;
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}

function createEntry(record: CreatorMonitorRecord): AutomationCreatorReadEntry {
  const { advertiserId, tiktokAccountId, identityId, identityType, identityAuthorizedBcId, credentialAdvertiserId, tiktokUsername } = record;
  const clientId = `mon_${advertiserId}`;
  const binding = Object.freeze({ advertiserId, tiktokAccountId, identityId, identityType, identityAuthorizedBcId });
  const deps = { loadToken: makeTokenLoader(advertiserId, credentialAdvertiserId) };
  const readSnapshot = createMonitoredCreatorReader(deps, clientId, binding);
  const perf = createExtraCreatorAutomationPerformance(deps, advertiserId);
  return {
    creator: { clientId, advertiserId, tiktokAccountId, displayName: `@${tiktokUsername}`, monitoringOnly: true },
    accessReason: "upstream-unavailable",
    adapter: { clientId, binding, readSnapshot, readCampaignDay: createCreatorCampaignDayReader(deps, binding),
      readUsername: createCreatorIdentityUsernameReader(deps, binding), async readPerformance(scope) {
        const verified = await readSnapshot();
        if (verified.campaign?.campaignId !== scope.campaignId || verified.reportingDate !== scope.reportingDate)
          return { state: "unavailable", observedAt: null, series: [] };
        return perf(scope);
      } },
  };
}

export function createCreatorMonitorRuntime(getCredentialSource: (advertiserId: string) => string | undefined) {
  const store = createCreatorMonitorStore(AppDataSource);
  const cache = new Map<string, AutomationCreatorReadEntry>();
  let initialized = false;
  return {
    available: () => initialized && process.env.CREATOR_READ_ENABLED === "true",
    async initialize() {
      if (process.env.CREATOR_READ_ENABLED !== "true") return;
      try { await store.ensureSchema(); initialized = true; } catch { initialized = false; }
    },
    async entries(owner: number) {
      return (await store.list(owner)).map(record => {
        const key = JSON.stringify(record);
        const existing = cache.get(key);
        if (existing) return existing;
        const entry = createEntry(record);
        if (cache.size >= cacheLimit) cache.clear();
        cache.set(key, entry);
        return entry;
      });
    },
    async enroll(owner: number, candidate: CreatorMonitorCandidate) {
      const credentialAdvertiserId = getCredentialSource(candidate.advertiserId);
      if (!monitorResourceId(credentialAdvertiserId)) throw new Error("MONITOR_CREDENTIAL_UNVERIFIED");
      const loadToken = makeTokenLoader(candidate.advertiserId, credentialAdvertiserId);
      const verify = createCreatorMonitorProof({ loadToken: id => id === candidate.advertiserId ? loadToken() : Promise.reject(new Error("MONITOR_CREDENTIAL_SCOPE")) });
      const proof = await verify(candidate);
      return store.add(owner, { ...proof, credentialAdvertiserId });
    },
  };
}
