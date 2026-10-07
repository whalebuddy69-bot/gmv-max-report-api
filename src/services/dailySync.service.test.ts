import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRepository: vi.fn(),
  listStores: vi.fn(),
  getReport: vi.fn(),
  getToken: vi.fn(),
  refreshMetadata: vi.fn(),
  claimTargetSync: vi.fn(),
  releaseTargetSync: vi.fn(),
  reloadTarget: vi.fn(),
}));

vi.mock("../db/dataSource", () => ({ AppDataSource: { getRepository: mocks.getRepository } }));
vi.mock("../config", () => ({ config: { sync: { lookbackDays: 3, tzOffsetMinutes: 420 } } }));
vi.mock("../utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./token.service", () => ({ getAccessTokenForAdvertiser: mocks.getToken }));
vi.mock("./store.service", () => ({ listStoresForAdvertiser: vi.fn() }));
vi.mock("./creatorProvisioning.service", () => ({ provisionCreatorForStore: vi.fn() }));
vi.mock("./videoMetadata.service", () => ({ startVideoMetadataRefresh: mocks.refreshMetadata }));
vi.mock("../cron/syncState", () => ({ claimTargetSync: mocks.claimTargetSync, releaseTargetSync: mocks.releaseTargetSync }));
vi.mock("./tiktokApi.service", () => ({
  TikTokApiService: vi.fn(function () {
    return { listStores: mocks.listStores, getReport: mocks.getReport };
  }),
}));

import { CampaignDaily } from "../entities/CampaignDaily";
import { CreativeDaily } from "../entities/CreativeDaily";
import { ProductDaily } from "../entities/ProductDaily";
import { LiveRoomDaily } from "../entities/LiveRoomDaily";
import { SyncRun } from "../entities/SyncRun";
import { SyncTarget } from "../entities/SyncTarget";
import { resolveSyncDateRange, syncAllTargets, syncTarget } from "./dailySync.service";

const storeId = "7495637369664014736";
const advertiserId = "7582163856857006081";
const now = new Date("2026-10-06T18:00:00Z"); // Already October 7 in Bangkok.
const previousSync = new Date("2026-10-05T00:00:00Z");

let runSaves: SyncRun[];
let targetSaves: { where: { id: number }; patch: Partial<SyncTarget> }[];
let reportRepos: Map<unknown, { upsert: ReturnType<typeof vi.fn>; stored: Map<string, unknown> }>;
let targetsToSync: SyncTarget[];

function target(lastSyncedAt: Date | null = null): SyncTarget {
  return { id: 1, advertiserId, storeId, enabled: true, lastSyncedAt, lastError: null } as SyncTarget;
}

function reportFor(options: { startDate: string; dimensions: string[]; filtering: Record<string, string[]> }) {
  const date = `${options.startDate} 00:00:00`;
  switch (options.dimensions[0]) {
    case "campaign_id":
      return { rows: [{ dimensions: { campaign_id: options.filtering.gmv_max_promotion_types[0] === "LIVE" ? "live-campaign" : "product-campaign", stat_time_day: date }, metrics: { cost: "100", orders: "2", gross_revenue: "200" } }] };
    case "item_group_id":
      return { rows: [{ dimensions: { item_group_id: "product", stat_time_day: date }, metrics: { cost: "100", orders: "2" } }] };
    case "item_id":
      return { rows: [{ dimensions: { item_id: "7683142323382832402", stat_time_day: date }, metrics: { cost: "0", orders: "0", product_impressions: "0", creative_delivery_status: "LEARNING", shop_content_type: "VIDEO" } }] };
    case "room_id":
      return { rows: [{ dimensions: { room_id: "room", stat_time_day: date }, metrics: { cost: "100", orders: "2", live_views: "10" } }] };
    default:
      throw new Error(`Unexpected report dimension: ${options.dimensions[0]}`);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  runSaves = [];
  targetSaves = [];
  targetsToSync = [];
  reportRepos = new Map();
  for (const entity of [CampaignDaily, ProductDaily, CreativeDaily, LiveRoomDaily]) {
    const stored = new Map<string, unknown>();
    reportRepos.set(entity, {
      stored,
      upsert: vi.fn(async (rows: Record<string, unknown>[], conflictPaths: string[]) => {
        for (const row of rows) stored.set(conflictPaths.map((key) => String(row[key])).join(":"), row);
      }),
    });
  }
  mocks.getRepository.mockImplementation((entity) => {
    if (entity === SyncRun) return {
      create: (row: SyncRun) => ({ ...row }),
      save: vi.fn(async (row: SyncRun) => {
        runSaves.push({ ...row, rowCounts: row.rowCounts ? { ...row.rowCounts } : row.rowCounts });
        return row;
      }),
    };
    if (entity === SyncTarget) return {
      find: vi.fn(async () => targetsToSync),
      findOne: mocks.reloadTarget,
      update: vi.fn(async (where: { id: number }, patch: Partial<SyncTarget>) => {
        targetSaves.push({ where: { ...where }, patch: { ...patch } });
        return { affected: 1 };
      }),
    };
    const repo = reportRepos.get(entity);
    if (!repo) throw new Error("Unexpected repository");
    return repo;
  });
  mocks.getToken.mockResolvedValue("test-token");
  mocks.listStores.mockResolvedValue([{ store_id: storeId, store_authorized_bc_id: "test-bc" }]);
  mocks.getReport.mockImplementation(async (options) => reportFor(options));
  mocks.claimTargetSync.mockReturnValue(true);
  mocks.reloadTarget.mockImplementation(async ({ where }: { where: { id: number; enabled: boolean } }) =>
    targetsToSync.find((shop) => shop.id === where.id && shop.enabled === where.enabled) ?? null);
});

afterEach(() => vi.useRealTimers());

describe("initial history orchestration", () => {
  it("plans by the reporting timezone, not the previous UTC date", () => {
    expect(resolveSyncDateRange(target())).toEqual({ startDate: "2026-09-01", endDate: "2026-10-07" });
    vi.setSystemTime(new Date("2026-12-31T18:00:00Z"));
    expect(resolveSyncDateRange(target())).toEqual({ startDate: "2026-12-01", endDate: "2027-01-01" });
  });

  it("aggregates both windows into one run and marks success only after every report is saved", async () => {
    const shop = target();
    mocks.getReport.mockImplementation(async (options) => {
      expect(shop.lastSyncedAt).toBeNull();
      expect(targetSaves).toHaveLength(0);
      return reportFor(options);
    });
    const result = await syncTarget(shop);

    expect(result).toMatchObject({
      advertiserId, storeId, startDate: "2026-09-01", endDate: "2026-10-07", apiCalls: 11,
      rowCounts: { campaigns: 2, liveCampaigns: 2, products: 2, creatives: 2, liveRooms: 2 },
    });
    expect(mocks.listStores).toHaveBeenCalledTimes(1);
    expect(mocks.getToken).toHaveBeenCalledTimes(1);
    expect(mocks.getReport).toHaveBeenCalledTimes(10);
    const ranges = mocks.getReport.mock.calls.map(([call]) => `${call.startDate}..${call.endDate}`);
    expect(ranges).toEqual([
      ...Array(5).fill("2026-09-01..2026-09-30"),
      ...Array(5).fill("2026-10-01..2026-10-07"),
    ]);
    expect(new Set(runSaves.map((run) => run.id)).size).toBe(1);
    expect(runSaves.map((run) => run.status)).toEqual(["running", "success"]);
    expect(runSaves.at(-1)?.rowCounts).toEqual(result.rowCounts);
    expect(targetSaves).toHaveLength(1);
    expect(targetSaves[0]).toEqual({ where: { id: shop.id }, patch: { lastSyncedAt: now, lastError: null } });
    expect(shop.lastSyncedAt).toEqual(now);
    expect(shop.lastError).toBeNull();
    expect(mocks.refreshMetadata).toHaveBeenCalledTimes(1);
    expect(mocks.refreshMetadata).toHaveBeenCalledWith(storeId);
    expect(reportRepos.get(CreativeDaily)?.stored.size).toBe(2); // Zero-activity inventory is still preserved.
  });

  it("keeps an existing store on the configured rolling refresh", async () => {
    const result = await syncTarget(target(previousSync));
    expect(result).toMatchObject({ startDate: "2026-10-05", endDate: "2026-10-07", apiCalls: 6 });
    expect(mocks.getReport).toHaveBeenCalledTimes(5);
  });

  it("supports an explicit 30-day override on a new store", async () => {
    const result = await syncTarget(target(), 30);
    expect(result).toMatchObject({ startDate: "2026-09-08", endDate: "2026-10-07", apiCalls: 6 });
    expect(mocks.getReport).toHaveBeenCalledTimes(5);
  });

  it("can repair a previously short-synced store with initialHistory", async () => {
    const result = await syncTarget(target(previousSync), undefined, true);
    expect(result).toMatchObject({ startDate: "2026-09-01", endDate: "2026-10-07", apiCalls: 11 });
  });

  it("supports 62 days but limits every report request to 30 inclusive days", async () => {
    vi.setSystemTime(new Date("2026-08-31T03:00:00Z"));
    const result = await syncTarget(target(), 62);
    expect(result).toMatchObject({ startDate: "2026-07-01", endDate: "2026-08-31", apiCalls: 16 });
    expect(mocks.getReport.mock.calls.filter(([call]) => call.filtering.gmv_max_promotion_types?.[0] === "PRODUCT").map(([call]) => [call.startDate, call.endDate])).toEqual([
      ["2026-07-01", "2026-07-30"], ["2026-07-31", "2026-08-29"], ["2026-08-30", "2026-08-31"],
    ]);
  });

  it("retries a failed initial history from the beginning without duplicate records or marking it as rolling", async () => {
    const shop = target();
    let failSecondWindow = true;
    mocks.getReport.mockImplementation(async (options) => {
      if (failSecondWindow && options.startDate === "2026-10-01") throw new Error("Temporary report failure");
      return reportFor(options);
    });
    await expect(syncTarget(shop)).rejects.toThrow("Temporary report failure");
    expect(shop.lastSyncedAt).toBeNull();
    expect(shop.lastError).toBe("Temporary report failure");
    expect(runSaves.at(-1)).toMatchObject({
      status: "failed", apiCalls: 6,
      rowCounts: { campaigns: 1, liveCampaigns: 1, products: 1, creatives: 1, liveRooms: 1 },
    });
    expect(mocks.refreshMetadata).not.toHaveBeenCalled();
    expect(reportRepos.get(CreativeDaily)?.stored.size).toBe(1);

    failSecondWindow = false;
    const result = await syncTarget(shop);
    expect(result).toMatchObject({ startDate: "2026-09-01", endDate: "2026-10-07", apiCalls: 11 });
    expect(shop.lastSyncedAt).toEqual(now);
    expect(shop.lastError).toBeNull();
    expect(reportRepos.get(CreativeDaily)?.stored.size).toBe(2);
    expect(reportRepos.get(CampaignDaily)?.stored.size).toBe(4);
    expect(runSaves.map((run) => run.status)).toEqual(["running", "failed", "running", "success"]);
    expect(new Set(runSaves.map((run) => run.id)).size).toBe(2);
    expect(reportRepos.get(CreativeDaily)?.upsert.mock.calls.every(([, keys]) => JSON.stringify(keys) === JSON.stringify(["storeId", "campaignId", "itemGroupId", "itemId", "statDate"]))).toBe(true);
  });

  it("does not change the last successful timestamp when an existing store's repair fails", async () => {
    const shop = target(previousSync);
    mocks.getReport.mockRejectedValue(new Error("Unavailable"));
    await expect(syncTarget(shop, undefined, true)).rejects.toThrow("Unavailable");
    expect(shop.lastSyncedAt).toEqual(previousSync);
    expect(runSaves.at(-1)?.status).toBe("failed");
    expect(targetSaves).toEqual([{ where: { id: shop.id }, patch: { lastError: "Unavailable" } }]);
  });

  it("rejects invalid direct-call ranges before creating a run or calling TikTok", async () => {
    await expect(syncTarget(target(), 63)).rejects.toThrow(/lookbackDays/);
    expect(runSaves).toHaveLength(0);
    expect(mocks.listStores).not.toHaveBeenCalled();
  });
});

describe("scheduled target reservation", () => {
  it("skips an already-running target without making another TikTok request", async () => {
    targetsToSync = [target()];
    mocks.claimTargetSync.mockReturnValue(false);
    expect(await syncAllTargets()).toEqual([]);
    expect(mocks.claimTargetSync).toHaveBeenCalledWith(advertiserId, storeId);
    expect(mocks.releaseTargetSync).not.toHaveBeenCalled();
    expect(mocks.listStores).not.toHaveBeenCalled();
  });

  it("re-reads a target after claiming so a completed manual history does not repeat", async () => {
    targetsToSync = [target()];
    mocks.reloadTarget.mockResolvedValue(target(previousSync));
    const [result] = await syncAllTargets();
    expect(result.startDate).toBe("2026-10-05");
    expect(mocks.reloadTarget).toHaveBeenCalledWith({ where: { id: 1, enabled: true } });
  });

  it("skips a target disabled or removed while a preceding store was syncing", async () => {
    targetsToSync = [target()];
    mocks.reloadTarget.mockResolvedValue(null);
    expect(await syncAllTargets()).toEqual([]);
    expect(mocks.listStores).not.toHaveBeenCalled();
    expect(mocks.releaseTargetSync).toHaveBeenCalledTimes(1);
    expect(mocks.releaseTargetSync).toHaveBeenCalledWith(advertiserId, storeId);
  });

  it.each([false, true])("releases the reservation after success or failure: failed=%s", async (failed) => {
    targetsToSync = [target()];
    if (failed) mocks.getReport.mockRejectedValue(new Error("Unavailable"));
    const results = await syncAllTargets();
    expect(results).toHaveLength(failed ? 0 : 1);
    expect(mocks.releaseTargetSync).toHaveBeenCalledTimes(1);
    expect(mocks.releaseTargetSync).toHaveBeenCalledWith(advertiserId, storeId);
  });
});
