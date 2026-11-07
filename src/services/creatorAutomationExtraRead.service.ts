import { createExtraCreatorTokenLoader } from "../routes/creatorRead.route";
import { createExtraCreatorReader, type CreatorReadBinding, type CreatorReadDependencies } from "./creatorRead.service";
import { createExtraCreatorAutomationPerformance, type CreatorAutomationPerformance, type CreatorAutomationScope } from "./creatorAutomationPerformance.service";

type VerifiedExtraBinding = Omit<CreatorReadBinding, "identityType"> & { clientId: string; identityType: "BC_AUTH_TT" };

/** A private runtime factory, not a request parser. The registry matches proof to configured metadata before use. */
export function createVerifiedExtraCreatorReadAdapter(configured: VerifiedExtraBinding, overrides: Partial<CreatorReadDependencies> = {}) {
  const { clientId, advertiserId, tiktokAccountId, identityId, identityType, identityAuthorizedBcId } = configured;
  const binding = Object.freeze({ advertiserId, tiktokAccountId, identityId, identityType, identityAuthorizedBcId });
  const deps = { ...overrides, loadToken: overrides.loadToken ?? createExtraCreatorTokenLoader(advertiserId) };
  const readSnapshot = createExtraCreatorReader(deps, clientId, binding);
  const performance = createExtraCreatorAutomationPerformance(deps, advertiserId);

  return Object.freeze({
    clientId, binding, tiktokAccountIdVerified: false as const,
    readSnapshot,
    async readPerformance(scope: CreatorAutomationScope): Promise<CreatorAutomationPerformance> {
      const unavailable = { state: "unavailable", observedAt: null, series: [] } as const;
      const { campaignId, reportingDate } = scope;
      try {
        // A second guard confines performance reads to this adapter's own
        // current verified campaign, even if another row accidentally passes
        // its campaign ID or a campaign switched since the overview read.
        const verified = await readSnapshot();
        if (verified.campaign?.campaignId !== campaignId || verified.reportingDate !== reportingDate) {
          return { ...unavailable, series: [] };
        }
        return performance({ campaignId, reportingDate });
      } catch { return { ...unavailable, series: [] }; }
    },
  });
}
