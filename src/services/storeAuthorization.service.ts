import { AppDataSource } from "../db/dataSource";
import { StoreCatalog } from "../entities/StoreCatalog";
import { SyncTarget } from "../entities/SyncTarget";
import { discoverSyncTargets } from "./dailySync.service";
import { describeError } from "../utils/errors";
import { logger } from "../utils/logger";

/**
 * Authorization status per shop, and the reason when a shop cannot be pulled.
 * Reads store_catalog (all discovered shops) rather than sync_targets. Only shops
 * under an advertiser that has a token can appear here.
 */

export type StoreAuthorizationStatus =
  /** Pulling normally and has rows. */
  | "ok"
  /** Ours and syncing, but no fact rows in the window we have. */
  | "noData"
  /** Ours, but the last sync recorded an error. */
  | "syncError"
  /** Ours, but switched off by hand in sync_targets. */
  | "syncDisabled"
  /** Ours by token, but no sync_targets row yet, discovery has not run since. */
  | "notDiscovered"
  /** Another ad account holds GMV Max rights. This is the "go authorize it" case. */
  | "notAuthorized"
  /** TikTok reports GMV Max is not available for this shop at all. */
  | "gmvMaxUnavailable";

export interface StoreAuthorizationRow {
  storeId: string;
  storeName: string;
  storeCode?: string;
  /** The advertiser whose token this store was seen through. */
  advertiserId: string;
  status: StoreAuthorizationStatus;
  /** Human-readable Thai explanation of `status`. */
  reason: string;
  /** What the operator should do next; null when nothing is needed. */
  action: string | null;

  isGmvMaxAvailable: boolean;
  storeStatus?: string;
  exclusiveAdvertiserId?: string;
  exclusiveAdvertiserName?: string;
  storeAuthorizedBcId?: string;
  bcName?: string;

  /** From sync_targets; null when there is no row for this (advertiser, store). */
  syncEnabled: boolean | null;
  lastSyncedAt: string | null;
  lastError: string | null;

  /** From report_campaign_daily. */
  firstDate: string | null;
  lastDate: string | null;
  rowCount: number;
}

export interface StoreAuthorizationResult {
  stores: StoreAuthorizationRow[];
  /** Advertisers whose store list could not be fetched, usually an expired token. */
  advertiserErrors: { advertiserId: string; message: string }[];
  /** How many advertisers with a live token were checked. */
  advertisersChecked: number;
  /** ISO 8601. When `cached` is true this is the time of the underlying fetch. */
  checkedAt: string;
  cached: boolean;
}

/** Ranked best to worst, for picking a winner when two advertisers see the same shop. */
const STATUS_RANK: Record<StoreAuthorizationStatus, number> = {
  ok: 0,
  noData: 1,
  syncError: 2,
  syncDisabled: 3,
  notDiscovered: 4,
  notAuthorized: 5,
  gmvMaxUnavailable: 6,
};

interface Coverage {
  firstDate: string | null;
  lastDate: string | null;
  rowCount: number;
}

async function loadCoverage(): Promise<Map<string, Coverage>> {
  const rows: { store_id: string; first_date: string | null; last_date: string | null; n: string }[] =
    await AppDataSource.query(`
      SELECT store_id,
             to_char(min(stat_date), 'YYYY-MM-DD') AS first_date,
             to_char(max(stat_date), 'YYYY-MM-DD') AS last_date,
             count(*) AS n
      FROM report_campaign_daily
      GROUP BY store_id
    `);

  return new Map(
    rows.map((r) => [
      r.store_id,
      { firstDate: r.first_date, lastDate: r.last_date, rowCount: Number(r.n) },
    ])
  );
}

function classify(
  store: StoreCatalog,
  advertiserId: string,
  target: SyncTarget | undefined,
  coverage: Coverage | undefined
): Pick<StoreAuthorizationRow, "status" | "reason" | "action"> {
  const exclusive = store.exclusiveAdvertiserId;

  if (exclusive && exclusive !== advertiserId) {
    return {
      status: "notAuthorized",
      reason:
        `ร้านนี้ให้สิทธิ์ GMV Max กับ ad account ${store.exclusiveAdvertiserName ?? "?"} ` +
        `(${exclusive}) ซึ่งยังไม่ได้เชื่อมกับระบบ, ดึงข้อมูลผ่าน advertiser ${advertiserId} ` +
        `จะได้ตัวเลข 0 ทั้งหมด`,
      action: `authorize ad account ${exclusive}, กดปุ่ม "ขอสิทธิ์ร้านนี้" (POST /analytics/store-authorization/authorize-link) หรือผ่าน gmv-max-telegram-bot ก็ได้`,
    };
  }

  if (!store.isGmvMaxAvailable) {
    return {
      status: "gmvMaxUnavailable",
      reason: "TikTok แจ้งว่าร้านนี้ไม่ได้เปิดใช้ GMV Max",
      action: "ให้ร้านเปิด GMV Max ใน TikTok Shop ก่อน",
    };
  }

  if (!target) {
    return {
      status: "notDiscovered",
      reason: "ร้านนี้มีสิทธิ์ครบแล้ว แต่ยังไม่ถูกเพิ่มเข้ารายการ sync",
      action: "รอ discovery รอบถัดไป หรือสั่ง sync ด้วยมือ",
    };
  }

  if (!target.enabled) {
    return {
      status: "syncDisabled",
      reason: "ปิดการ sync ไว้ด้วยมือ",
      action: "ตั้ง enabled = true ในตาราง sync_targets",
    };
  }

  if (target.lastError) {
    return {
      status: "syncError",
      reason: `sync ครั้งล่าสุดล้มเหลว: ${target.lastError}`,
      action: "ตรวจ error แล้วสั่ง sync ใหม่",
    };
  }

  if (!coverage || coverage.rowCount === 0) {
    return {
      status: "noData",
      reason: target.lastSyncedAt
        ? "sync สำเร็จแต่ไม่มีข้อมูลกลับมาเลย, ร้านนี้อาจยังไม่เคยยิงแคมเปญ GMV Max"
        : "ยังไม่เคย sync",
      action: target.lastSyncedAt ? "ตรวจว่าร้านมีแคมเปญที่ใช้จ่ายจริงหรือไม่" : "สั่ง sync",
    };
  }

  return { status: "ok", reason: "ดึงข้อมูลได้ปกติ", action: null };
}

/** `refresh` re-runs discovery against TikTok before reading. */
export async function getStoreAuthorization(
  options: { refresh?: boolean } = {}
): Promise<StoreAuthorizationResult> {
  const advertiserErrors: { advertiserId: string; message: string }[] = [];

  if (options.refresh) {
    try {
      await discoverSyncTargets();
    } catch (err) {
      // A failed refresh still shows the last known catalog rather than nothing.
      const message = describeError(err);
      logger.warn("Store catalog refresh failed", { error: message });
      advertiserErrors.push({ advertiserId: "-", message });
    }
  }

  const [catalog, targets, coverage] = await Promise.all([
    AppDataSource.getRepository(StoreCatalog).find(),
    AppDataSource.getRepository(SyncTarget).find(),
    loadCoverage(),
  ]);

  const targetByKey = new Map(targets.map((t) => [`${t.advertiserId}:${t.storeId}`, t]));

  // a shop can appear under several advertisers; keep the best status
  const bestByStore = new Map<string, StoreAuthorizationRow>();

  for (const store of catalog) {
    const target = targetByKey.get(`${store.advertiserId}:${store.storeId}`);
    const cov = coverage.get(store.storeId);
    const { status, reason, action } = classify(store, store.advertiserId, target, cov);

    const row: StoreAuthorizationRow = {
      storeId: store.storeId,
      storeName: store.storeName ?? store.storeId,
      storeCode: store.storeCode ?? undefined,
      advertiserId: store.advertiserId,
      status,
      reason,
      action,
      isGmvMaxAvailable: store.isGmvMaxAvailable,
      storeStatus: store.storeStatus ?? undefined,
      exclusiveAdvertiserId: store.exclusiveAdvertiserId ?? undefined,
      exclusiveAdvertiserName: store.exclusiveAdvertiserName ?? undefined,
      storeAuthorizedBcId: store.storeAuthorizedBcId ?? undefined,
      bcName: store.bcName ?? undefined,
      syncEnabled: target ? target.enabled : null,
      lastSyncedAt: target?.lastSyncedAt ? target.lastSyncedAt.toISOString() : null,
      lastError: target?.lastError ?? null,
      firstDate: cov?.firstDate ?? null,
      lastDate: cov?.lastDate ?? null,
      rowCount: cov?.rowCount ?? 0,
    };

    const existing = bestByStore.get(store.storeId);
    if (!existing || STATUS_RANK[row.status] < STATUS_RANK[existing.status]) {
      bestByStore.set(store.storeId, row);
    }
  }

  // Worst first: this page exists to show what needs attention.
  const stores = [...bestByStore.values()].sort(
    (a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status] || a.storeName.localeCompare(b.storeName, "th")
  );

  // Age of the snapshot, not of this request, the UI says "ข้อมูล ณ" with it.
  const checkedAt = catalog.reduce<Date | null>(
    (newest, row) => (newest === null || row.seenAt > newest ? row.seenAt : newest),
    null
  );

  return {
    stores,
    advertiserErrors,
    advertisersChecked: new Set(catalog.map((row) => row.advertiserId)).size,
    checkedAt: (checkedAt ?? new Date()).toISOString(),
    // Always served from the catalog now; `refresh` refills it rather than bypassing it.
    cached: !options.refresh,
  };
}
