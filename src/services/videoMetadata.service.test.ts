import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), runnerQuery: vi.fn(), connect: vi.fn(), release: vi.fn(), fetch: vi.fn() }));
vi.mock("../db/dataSource", () => ({ AppDataSource: { query: mocks.query, createQueryRunner: () => ({ query: mocks.runnerQuery, connect: mocks.connect, release: mocks.release }) } }));
vi.mock("./publicVideoMetadata.service", () => ({ fetchPublicVideoMetadata: mocks.fetch }));
import { attachVideoMetadata, refreshStoreVideoMetadata } from "./videoMetadata.service";
const store = "7495637369664014736";
const id = "7683142323382832402";

beforeEach(() => { vi.clearAllMocks(); mocks.query.mockResolvedValue([]); mocks.runnerQuery.mockResolvedValue([]); });
afterEach(() => vi.useRealTimers());

describe("metadata join", () => {
  it("enriches by video ID without duplicating rows, changing names, or touching metrics", async () => {
    mocks.query.mockResolvedValueOnce([{ item_id: id, username: "creator", posted_at: new Date("2026-09-08T14:03:00Z"), posted_at_source: "tiktok_public_page" }]);
    const rows = await attachVideoMetadata([{ item_id: id, cost: 123, tt_account_name: "Display" }, { item_id: id, cost: 10, tt_account_name: "Display" }, { item_id: "-1", cost: 5 }]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ cost: 123, tt_account_name: "Display", tt_account_username: "creator", video_posted_at: "2026-09-08T14:03:00.000Z" });
    expect(rows[1].tt_account_username).toBe("creator");
    expect(rows[2].tt_account_username).toBeNull();
    expect(mocks.query.mock.calls[0][1]).toEqual([[id]]);
  });
  it("keeps missing metadata null and never substitutes a display name", async () => {
    expect(await attachVideoMetadata([{ item_id: id, tt_account_name: "Display" }])).toEqual([{ item_id: id, tt_account_name: "Display", tt_account_username: null, video_posted_at: null, video_posted_at_source: null }]);
  });
  it("does not query for an empty set or product cards", async () => {
    await attachVideoMetadata([{ item_id: "-1" }]);
    await attachVideoMetadata([]);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("preserves the financial report when the optional table has not been migrated yet", async () => {
    mocks.query.mockRejectedValueOnce(Object.assign(new Error("missing table"), { code: "42P01" }));
    expect(await attachVideoMetadata([{ item_id: id, cost: 123 }])).toEqual([
      { item_id: id, cost: 123, tt_account_username: null, video_posted_at: null, video_posted_at_source: null },
    ]);
  });
  it("does not hide unrelated database errors", async () => {
    mocks.query.mockRejectedValueOnce(Object.assign(new Error("connection lost"), { code: "08006" }));
    await expect(attachVideoMetadata([{ item_id: id }])).rejects.toThrow("connection lost");
  });
});

describe("bounded metadata refresh", () => {
  it("rejects unscoped refreshes and oversized requests", async () => {
    await expect(refreshStoreVideoMetadata("", 50)).rejects.toThrow();
    await expect(refreshStoreVideoMetadata(store, 501)).rejects.toThrow();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("does no work when another replica holds the store lock", async () => {
    mocks.runnerQuery.mockResolvedValueOnce([{ locked: false }]);
    expect((await refreshStoreVideoMetadata(store)).busy).toBe(true);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalled();
  });
  it("binds the store, excludes product cards, saves sources, and releases the lock", async () => {
    vi.useFakeTimers();
    mocks.runnerQuery.mockResolvedValueOnce([{ locked: true }]).mockResolvedValueOnce([{ item_id: id }]);
    mocks.fetch.mockResolvedValue({ username: "creator", postedAt: "2026-09-08T14:03:00Z", error: null });
    const work = refreshStoreVideoMetadata(store, 50);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await work).toMatchObject({ checked: 1, usernames: 1, postDates: 1, unavailable: 0 });
    expect(mocks.runnerQuery.mock.calls[1][1]).toEqual([store, 50]);
    expect(mocks.runnerQuery.mock.calls[1][0]).toContain("shop_content_type = 'VIDEO'");
    expect(mocks.query.mock.calls[0][1]).toEqual([id, "creator", "tiktok_oembed", "2026-09-08T14:03:00Z", "tiktok_public_page", 168, null]);
    expect(mocks.query.mock.calls[0][0]).toContain("coalesce(EXCLUDED.username, report_video_metadata.username)");
    expect(mocks.runnerQuery.mock.calls.at(-1)?.[0]).toContain("pg_advisory_unlock");
    expect(mocks.release).toHaveBeenCalled();
  });
  it("always releases the connection even when unlock fails", async () => {
    mocks.runnerQuery.mockResolvedValueOnce([{ locked: true }]).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("disconnect"));
    await expect(refreshStoreVideoMetadata(store)).rejects.toThrow("disconnect");
    expect(mocks.release).toHaveBeenCalled();
  });
});
