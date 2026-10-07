import cron from "node-cron";
import { config } from "../config";
import { AppDataSource } from "../db/dataSource";
import { SyncTarget } from "../entities/SyncTarget";
import { discoverSyncTargets, syncAllTargets, syncTarget } from "../services/dailySync.service";
import { cleanupExpiredWebOAuthStates } from "../services/webOAuth.service";
import { describeError } from "../utils/errors";
import { logger } from "../utils/logger";
import { claimTargetSync, releaseTargetSync, targetKey } from "./syncState";
export { targetKey, isTargetRunning, runningTargetKeys } from "./syncState";

let running = false;

/** Syncs one store in the background. Returns false if it is already running. */
export function startTargetSync(
  target: { advertiserId: string; storeId: string },
  lookbackDays?: number,
  initialHistory?: boolean
): boolean {
  const key = targetKey(target.advertiserId, target.storeId);
  if (!claimTargetSync(target.advertiserId, target.storeId)) return false;

  void (async () => {
    try {
      const full = await AppDataSource.getRepository(SyncTarget).findOne({
        where: { advertiserId: target.advertiserId, storeId: target.storeId },
      });
      if (!full) throw new Error(`ไม่พบ sync target ${key}`);
      await syncTarget(full, lookbackDays, initialHistory);
    } catch (err) {
      // error is already saved on the target row
      logger.warn("Manual store sync failed", { target: key, error: describeError(err) });
    } finally {
      releaseTargetSync(target.advertiserId, target.storeId);
    }
  })();

  return true;
}

export async function runSyncOnce(reason: string): Promise<void> {
  if (running) {
    logger.warn("Sync already running, skipping this tick", { reason });
    return;
  }

  running = true;
  const startedAt = Date.now();
  try {
    await cleanupExpiredWebOAuthStates();

    if (config.sync.autoDiscover) {
      await discoverSyncTargets();
    }
    const results = await syncAllTargets();
    logger.info("Sync tick finished", {
      reason,
      stores: results.length,
      apiCalls: results.reduce((sum, r) => sum + r.apiCalls, 0),
      seconds: Math.round((Date.now() - startedAt) / 1000),
    });
  } catch (err) {
    logger.error("Sync tick failed", { reason, error: describeError(err) });
  } finally {
    running = false;
  }
}

export function startSyncCron(): void {
  if (!config.sync.enabled) {
    logger.info("Background sync disabled (set SYNC_ENABLED=true to turn it on)");
    return;
  }

  if (!cron.validate(config.sync.cron)) {
    logger.error("SYNC_CRON is not a valid cron expression, sync not started", {
      cron: config.sync.cron,
    });
    return;
  }

  cron.schedule(config.sync.cron, () => {
    void runSyncOnce("cron");
  });

  logger.info("Background sync scheduled", {
    cron: config.sync.cron,
    lookbackDays: config.sync.lookbackDays,
  });

  if (config.sync.runOnStartup) {
    void runSyncOnce("startup");
  } else {
    logger.info("Startup sync skipped (SYNC_ON_STARTUP=false), waiting for the first cron tick");
  }
}

export function isSyncRunning(): boolean {
  return running;
}
