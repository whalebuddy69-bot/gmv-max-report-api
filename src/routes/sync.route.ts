import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/dataSource";
import { SyncRun } from "../entities/SyncRun";
import { SyncTarget } from "../entities/SyncTarget";
import { isSyncRunning, runningTargetKeys, runSyncOnce, startTargetSync } from "../cron/syncReports";
import { discoverSyncTargets, resolveSyncDateRange } from "../services/dailySync.service";
import { syncRunSchema } from "./syncRequest";
import { NotFoundError, ValidationError } from "../utils/errors";
import { config } from "../config";

export const syncRouter = Router();

/** GET /sync/status: targets, their last result, and the most recent runs. */
syncRouter.get("/status", async (_req, res, next) => {
  try {
    const targets = await AppDataSource.getRepository(SyncTarget).find({ order: { id: "ASC" } });
    const runs = await AppDataSource.getRepository(SyncRun).find({
      order: { startedAt: "DESC" },
      take: 20,
    });

    res.json({
      enabled: config.sync.enabled,
      cron: config.sync.cron,
      lookbackDays: config.sync.lookbackDays,
      running: isSyncRunning(),
      // Stores reserved by either manual or scheduled sync, as "advertiserId:storeId".
      runningTargets: runningTargetKeys(),
      targets,
      recentRuns: runs,
    });
  } catch (err) {
    next(err);
  }
});

/** POST /sync/discover: refresh sync_targets and the bot's creators table. */
syncRouter.post("/discover", async (_req, res, next) => {
  try {
    const { targets, provisioned } = await discoverSyncTargets();
    res.json({ count: targets.length, targets, provisionedCreators: provisioned });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /sync/run: start a sync in the background.
 * No body: all enabled targets. With advertiserId + storeId: that store only.
 */
syncRouter.post("/run", async (req, res, next) => {
  try {
    const parsed = syncRunSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError("request body ไม่ถูกต้อง", { issues: parsed.error.issues });
    }
    const { advertiserId, storeId, lookbackDays, initialHistory } = parsed.data;

    if (!advertiserId || !storeId) {
      if (isSyncRunning()) {
        res.status(409).json({ error: { code: "SYNC_RUNNING", message: "sync กำลังทำงานอยู่แล้ว" } });
        return;
      }
      void runSyncOnce("manual");
      res.status(202).json({ started: true, message: "sync เริ่มทำงานแล้ว, ดูผลที่ GET /sync/status" });
      return;
    }

    const target = await AppDataSource.getRepository(SyncTarget).findOne({
      where: { advertiserId, storeId },
    });
    if (!target) {
      throw new NotFoundError(
        `ไม่พบ sync target สำหรับ advertiser ${advertiserId} / store ${storeId}, ` +
          `เรียก POST /sync/discover ก่อน`
      );
    }

    const range = resolveSyncDateRange(target, lookbackDays, initialHistory);
    if (!startTargetSync(target, lookbackDays, initialHistory)) {
      res.status(409).json({
        error: { code: "SYNC_RUNNING", message: "ร้านนี้กำลัง sync อยู่แล้ว" },
      });
      return;
    }

    res.status(202).json({
      started: true,
      advertiserId,
      storeId,
      range,
      message: "เริ่ม sync แล้ว, ดูผลที่ GET /sync/status",
    });
  } catch (err) {
    next(err);
  }
});

const toggleSchema = z.object({ enabled: z.boolean() });

/** PATCH /sync/targets/:id: enable or disable one store. */
syncRouter.patch("/targets/:id", async (req, res, next) => {
  try {
    const parsed = toggleSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("ต้องส่ง { enabled: true | false }");
    }

    const repo = AppDataSource.getRepository(SyncTarget);
    const target = await repo.findOne({ where: { id: Number(req.params.id) } });
    if (!target) throw new NotFoundError(`ไม่พบ sync target id ${req.params.id}`);

    target.enabled = parsed.data.enabled;
    await repo.save(target);
    res.json(target);
  } catch (err) {
    next(err);
  }
});
