import { AppDataSource } from "../db/dataSource";
import { logger } from "../utils/logger";
import { fetchPublicVideoMetadata } from "./publicVideoMetadata.service";

export interface MetadataRefreshResult {
  storeId: string;
  selected: number;
  checked: number;
  usernames: number;
  postDates: number;
  unavailable: number;
  busy: boolean;
}

/** Bounded, separate metadata work: never changes campaign spend or daily performance. */
export async function refreshStoreVideoMetadata(storeId: string, limit = 50): Promise<MetadataRefreshResult> {
  if (!/^\d{16,22}$/.test(storeId) || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Invalid metadata refresh scope");
  }
  const result: MetadataRefreshResult = { storeId, selected: 0, checked: 0, usernames: 0, postDates: 0, unavailable: 0, busy: false };
  const runner = AppDataSource.createQueryRunner();
  await runner.connect();
  let locked = false;
  try {
    const [lock] = await runner.query("SELECT pg_try_advisory_lock(hashtext('video_metadata'), hashtext($1)) AS locked", [storeId]);
    locked = lock.locked;
    if (!locked) return { ...result, busy: true };
    const items: { item_id: string }[] = await runner.query(`
      SELECT c.item_id
      FROM (SELECT DISTINCT item_id FROM report_creative_daily
            WHERE store_id = $1 AND shop_content_type = 'VIDEO' AND item_id ~ '^[0-9]{16,22}$') c
      LEFT JOIN report_video_metadata m ON m.item_id = c.item_id
      WHERE m.item_id IS NULL OR m.next_check_at <= now()
      ORDER BY m.checked_at NULLS FIRST, c.item_id
      LIMIT $2`, [storeId, limit]);
    result.selected = items.length;
    const deadline = Date.now() + 55_000;
    let cursor = 0;
    let stop = false;
    const worker = async () => {
      while (!stop && cursor < items.length && Date.now() < deadline) {
        const { item_id } = items[cursor++];
        const data = await fetchPublicVideoMetadata(item_id);
        const retryHours = data.postedAt && data.username ? 24 * 7 : data.username ? 24 : 6;
        await AppDataSource.query(`
          INSERT INTO report_video_metadata
            (item_id, username, username_source, posted_at, posted_at_source, checked_at, next_check_at, last_error)
          VALUES ($1, $2, $3, $4, $5, now(), now() + $6 * interval '1 hour', $7)
          ON CONFLICT (item_id) DO UPDATE SET
            username = coalesce(EXCLUDED.username, report_video_metadata.username),
            username_source = coalesce(EXCLUDED.username_source, report_video_metadata.username_source),
            posted_at = coalesce(EXCLUDED.posted_at, report_video_metadata.posted_at),
            posted_at_source = coalesce(EXCLUDED.posted_at_source, report_video_metadata.posted_at_source),
            checked_at = EXCLUDED.checked_at, next_check_at = EXCLUDED.next_check_at,
            last_error = EXCLUDED.last_error`,
          [item_id, data.username, data.username ? "tiktok_oembed" : null,
            data.postedAt, data.postedAt ? "tiktok_public_page" : null, retryHours, data.error]);
        result.checked += 1;
        if (data.username) result.usernames += 1;
        if (data.postedAt) result.postDates += 1;
        if (data.error) result.unavailable += 1;
        if (data.error === "public_metadata_http_429" || data.error === "public_metadata_http_403") stop = true;
        // Two workers per store; background store jobs are serialized below.
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    };
    const workers = await Promise.allSettled([worker(), worker()]);
    const failure = workers.find((worker) => worker.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return result;
  } finally {
    try {
      if (locked) await runner.query("SELECT pg_advisory_unlock(hashtext('video_metadata'), hashtext($1))", [storeId]);
    } finally {
      await runner.release();
    }
  }
}

const running = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();

export function startVideoMetadataRefresh(storeId: string, limit = 50): boolean {
  if (running.has(storeId)) return false;
  running.add(storeId);
  queue = queue.then(() => refreshStoreVideoMetadata(storeId, limit))
    .then((result) => logger.info("Video metadata refresh finished", { ...result }))
    .catch(() => logger.warn("Video metadata refresh failed", { storeId }))
    .finally(() => running.delete(storeId));
  return true;
}

export async function attachVideoMetadata<T extends { item_id?: unknown }>(rows: T[]): Promise<(T & {
  tt_account_username: string | null;
  video_posted_at: string | null;
  video_posted_at_source: string | null;
})[]> {
  const ids = [...new Set(rows.map((r) => r.item_id).filter((id): id is string => typeof id === "string" && /^\d{16,22}$/.test(id)))];
  let metadata: { item_id: string; username: string | null; posted_at: Date | null; posted_at_source: string | null }[] = [];
  if (ids.length) {
    try {
      metadata = await AppDataSource.query("SELECT item_id, username, posted_at, posted_at_source FROM report_video_metadata WHERE item_id = ANY($1::text[])", [ids]);
    } catch (error) {
      // Optional enrichment must not take the financial report offline during a rollout.
      if ((error as { code?: string })?.code !== "42P01") throw error;
      logger.warn("Video metadata table missing; serving report without enrichment");
    }
  }
  const byId = new Map(metadata.map((m) => [m.item_id, m]));
  return rows.map((row) => {
    const m = byId.get(String(row.item_id));
    return { ...row, tt_account_username: m?.username ?? null,
      video_posted_at: m?.posted_at ? new Date(m.posted_at).toISOString() : null,
      video_posted_at_source: m?.posted_at_source ?? null };
  });
}
