import { describe, expect, it } from "vitest";
import { allowsScheduledCreatorAuto, configuredCreatorAutoBudgetMode, configuredCreatorScheduledAutoLive, configuredCreatorWebBudgetMode,
  creatorBudgetPolicyPath, isContinuousCreatorBudgetScope, isExtraCreatorBudgetScope, isLegacyAutoBudgetScope, isVerifiedRoomCreator,
  LIVE_ROOM_SPEND_TREND, supportsContinuousEvidence } from "./creatorBudgetScope";

const CLIENT = "luckyandrich59";
const flags = { CREATOR_READ_ENABLED: "true", CREATOR_WEB_BUDGET_LIVE_ENABLED: "true",
  CREATOR_WEB_LUCKYANDRICH59_BUDGET_MODE: "live", CREATOR_WEB_LUCKYANDRICH59_BUDGET_LIVE_ENABLED: "true",
  CREATOR_AUTO_BUDGET_LUCKYANDRICH59_MODE: "live", CREATOR_AUTO_BUDGET_LUCKYANDRICH59_LIVE_ENABLED: "true" };

describe("isolated luckyandrich59 budget scope", () => {
  it("allows only the verified-room continuous path, never a legacy grant or another account's policy", () => {
    expect(isExtraCreatorBudgetScope(CLIENT)).toBe(true);
    expect(isContinuousCreatorBudgetScope(CLIENT)).toBe(true);
    expect(isVerifiedRoomCreator(CLIENT)).toBe(true);
    expect(allowsScheduledCreatorAuto(CLIENT)).toBe(true);
    expect(isLegacyAutoBudgetScope(CLIENT)).toBe(false);
    expect(supportsContinuousEvidence(CLIENT, LIVE_ROOM_SPEND_TREND)).toBe(true);
    expect(supportsContinuousEvidence(CLIENT, "spend-trend")).toBe(false);
    expect(supportsContinuousEvidence(CLIENT, "verified-room")).toBe(false);
    expect(creatorBudgetPolicyPath(CLIENT)).toBe("/luckyandrich59/policy");
    for (const candidate of ["luckyandrich59 ", "Luckyandrich59", "luckyandrich59;DROP", "constructor"]) {
      expect(isExtraCreatorBudgetScope(candidate)).toBe(false);
      expect(isContinuousCreatorBudgetScope(candidate)).toBe(false);
    }
  });

  it("is disabled by default and requires all four own flags, without enabling any other Creator", () => {
    expect(configuredCreatorWebBudgetMode({}, CLIENT)).toBe("disabled");
    expect(configuredCreatorAutoBudgetMode({}, CLIENT)).toBe("disabled");
    expect(configuredCreatorScheduledAutoLive({}, CLIENT)).toBe(false);
    expect(configuredCreatorWebBudgetMode(flags, CLIENT)).toBe("live");
    expect(configuredCreatorAutoBudgetMode(flags, CLIENT)).toBe("live");
    expect(configuredCreatorScheduledAutoLive(flags, CLIENT)).toBe(true);
    expect(configuredCreatorScheduledAutoLive({ ...flags, CREATOR_AUTO_BUDGET_LIVE_ENABLED: "false" }, CLIENT)).toBe(true);
    for (const field of ["CREATOR_READ_ENABLED", "CREATOR_WEB_BUDGET_LIVE_ENABLED", "CREATOR_WEB_LUCKYANDRICH59_BUDGET_MODE",
      "CREATOR_WEB_LUCKYANDRICH59_BUDGET_LIVE_ENABLED", "CREATOR_AUTO_BUDGET_LUCKYANDRICH59_MODE", "CREATOR_AUTO_BUDGET_LUCKYANDRICH59_LIVE_ENABLED"]) {
      expect(configuredCreatorScheduledAutoLive({ ...flags, [field]: "false" }, CLIENT)).toBe(false);
    }
    expect(configuredCreatorScheduledAutoLive({ ...flags, CREATOR_BUDGET_TEST_ENABLED: "true" }, CLIENT)).toBe(false);
    expect(configuredCreatorAutoBudgetMode(flags, "boomkan")).toBe("disabled");
    expect(configuredCreatorAutoBudgetMode(flags, "nnshop5719")).toBe("disabled");
    expect(configuredCreatorAutoBudgetMode(flags, "punpan_020")).toBe("disabled");
  });
});
