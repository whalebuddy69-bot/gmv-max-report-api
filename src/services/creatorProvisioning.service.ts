import { AppDataSource } from "../db/dataSource";
import { logger } from "../utils/logger";

/**
 * Creates/updates rows in the bot's `creators` table for discovered stores.
 * Existing name and is_active are left alone; store_authorized_bc_id is only filled
 * when empty and shop_authorized only goes false -> true. Never deletes rows.
 */
export type ProvisionOutcome = "created" | "backfilled" | "unchanged" | "skipped";

export async function provisionCreatorForStore(params: {
  advertiserId: string;
  storeId: string;
  storeName: string;
  storeAuthorizedBcId: string;
}): Promise<ProvisionOutcome> {
  const { advertiserId, storeId, storeName, storeAuthorizedBcId } = params;
  if (!storeAuthorizedBcId) return "skipped"; // Nothing usable to write yet.

  try {
    const existing: { id: number; store_authorized_bc_id: string | null; shop_authorized: boolean }[] =
      await AppDataSource.query(
        `SELECT id, store_authorized_bc_id, shop_authorized FROM creators
         WHERE advertiser_id = $1 AND store_id = $2
         LIMIT 1`,
        [advertiserId, storeId]
      );

    if (existing.length === 0) {
      await AppDataSource.query(
        `INSERT INTO creators
           (name, advertiser_id, store_id, store_authorized_bc_id, shop_authorized, is_active, created_at)
         VALUES ($1, $2, $3, $4, true, true, now())`,
        [storeName, advertiserId, storeId, storeAuthorizedBcId]
      );
      logger.info("Provisioned creators row for bot", { advertiserId, storeId, storeName });
      return "created";
    }

    const row = existing[0];
    const needsBcId = !row.store_authorized_bc_id;
    const needsShopFlag = row.shop_authorized !== true;
    if (!needsBcId && !needsShopFlag) return "unchanged";

    await AppDataSource.query(
      `UPDATE creators SET
         store_authorized_bc_id = COALESCE(store_authorized_bc_id, $1),
         shop_authorized = true
       WHERE id = $2`,
      [storeAuthorizedBcId, row.id]
    );
    logger.info("Backfilled creators row for bot", {
      advertiserId,
      storeId,
      creatorId: row.id,
      filledBcId: needsBcId,
      filledShopFlag: needsShopFlag,
    });
    return "backfilled";
  } catch (err) {
    // Best-effort: a failure here must never fail store discovery for the store itself.
    logger.warn("Could not provision creators row", {
      advertiserId,
      storeId,
      error: err instanceof Error ? err.message : String(err),
    });
    return "skipped";
  }
}
