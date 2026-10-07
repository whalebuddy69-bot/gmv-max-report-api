import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findOne: vi.fn(), syncTarget: vi.fn() }));
vi.mock("../db/dataSource", () => ({ AppDataSource: { getRepository: () => ({ findOne: mocks.findOne }) } }));
vi.mock("../services/dailySync.service", () => ({
  syncTarget: mocks.syncTarget, discoverSyncTargets: vi.fn(), syncAllTargets: vi.fn(),
}));
vi.mock("../services/webOAuth.service", () => ({ cleanupExpiredWebOAuthStates: vi.fn() }));
vi.mock("../utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../config", () => ({ config: { sync: { enabled: false } } }));

import { startTargetSync } from "./syncReports";
import { claimTargetSync, isTargetRunning, releaseTargetSync } from "./syncState";

const target = { id: 16, advertiserId: "7509010106013581313", storeId: "7494779514917587663", lastSyncedAt: null };

beforeEach(() => {
  mocks.findOne.mockReset().mockResolvedValue(target);
  mocks.syncTarget.mockReset().mockResolvedValue({});
});
afterEach(() => releaseTargetSync(target.advertiserId, target.storeId));

describe("manual history sync orchestration", () => {
  it.each([
    [undefined, undefined], [30, undefined], [undefined, true],
  ])("forwards the selected policy and releases the reservation (%s, %s)", async (days, history) => {
    expect(startTargetSync(target, days, history)).toBe(true);
    expect(isTargetRunning(target.advertiserId, target.storeId)).toBe(true);
    await vi.waitFor(() => expect(mocks.syncTarget).toHaveBeenCalledWith(target, days, history));
    expect(isTargetRunning(target.advertiserId, target.storeId)).toBe(false);
  });
  it("rejects a manual start while the scheduled sync owns the same target", () => {
    claimTargetSync(target.advertiserId, target.storeId);
    expect(startTargetSync(target, undefined, true)).toBe(false);
    expect(mocks.findOne).not.toHaveBeenCalled();
    expect(mocks.syncTarget).not.toHaveBeenCalled();
  });
  it("releases after a failed sync so the same history can be retried", async () => {
    mocks.syncTarget.mockRejectedValueOnce(new Error("transient upstream error"));
    expect(startTargetSync(target, undefined, true)).toBe(true);
    await vi.waitFor(() => expect(isTargetRunning(target.advertiserId, target.storeId)).toBe(false));
    expect(startTargetSync(target, undefined, true)).toBe(true);
    await vi.waitFor(() => expect(mocks.syncTarget).toHaveBeenCalledTimes(2));
  });
  it("releases if the target disappeared before the queued job started", async () => {
    mocks.findOne.mockResolvedValueOnce(null);
    expect(startTargetSync(target, undefined, true)).toBe(true);
    await vi.waitFor(() => expect(isTargetRunning(target.advertiserId, target.storeId)).toBe(false));
    expect(mocks.syncTarget).not.toHaveBeenCalled();
  });
});
