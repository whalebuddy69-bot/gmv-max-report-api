import "reflect-metadata";
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import fs from "fs/promises";
import { config } from "./config";
import { AppDataSource } from "./db/dataSource";
import { analyticsRouter } from "./routes/analytics.route";
import { automationRouter } from "./routes/automation.route";
import { authRouter } from "./routes/auth.route";
import { oauthRouter } from "./routes/oauth.route";
import { usersRouter } from "./routes/users.route";
import { reportsRouter } from "./routes/reports.route";
import { storesRouter } from "./routes/stores.route";
import { syncRouter } from "./routes/sync.route";
import { requireInternalKey } from "./middleware/auth";
import { startSyncCron } from "./cron/syncReports";
import { AppError, describeError } from "./utils/errors";
import { logger } from "./utils/logger";
import { creatorReadRouter } from "./routes/creatorRead.route";
import { createCreatorBudgetTestRuntime } from "./services/creatorBudgetTest.runtime";
import { createCreatorWebBudgetRuntime } from "./services/creatorWebBudget.runtime";
import { createPpanCampaignActionsRuntime } from "./services/creatorCampaignActions.runtime";

const app = express();
const creatorBudgetTest = createCreatorBudgetTestRuntime();
const creatorWebBudget = createCreatorWebBudgetRuntime();
const ppanCampaignActions = createPpanCampaignActionsRuntime();

app.use(
  cors({
    origin: config.corsOrigins.includes("*") ? true : config.corsOrigins,
    credentials: true,
  })
);
// Dedicated auth/origin and a bounded request parser, before the general JSON parser.
app.use("/automation/budget", creatorWebBudget.router);
app.use("/automation/campaign", ppanCampaignActions.router);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, db: AppDataSource.isInitialized });
});

// web app (JWT)
app.use("/auth", authRouter);
app.use("/analytics", analyticsRouter);
app.use("/automation", automationRouter);
app.use("/users", usersRouter);

// TikTok OAuth redirect (no auth)
app.use("/oauth", oauthRouter);

// Dedicated server-to-server Creator read pilot. No existing Shop routes or tokens change.
app.use("/internal/creator", creatorReadRouter);
app.use("/internal/creator", creatorWebBudget.watchRouter);
app.use("/internal/creator", creatorBudgetTest.router);

// internal (telegram bot)
app.use("/stores", requireInternalKey, storesRouter);
app.use("/reports", requireInternalKey, reportsRouter);
app.use("/sync", requireInternalKey, syncRouter);

app.use((_req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "route ไม่พบ" } });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) {
    logger.error("Error after response started", { error: describeError(err) });
    return;
  }

  if (err instanceof AppError) {
    logger.warn("Request failed", { code: err.code, message: err.message });
    res.status(err.httpStatus).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  logger.error("Unhandled error", { error: describeError(err) });
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: describeError(err) },
  });
});

async function main(): Promise<void> {
  await AppDataSource.initialize();
  // Isolated additive ledger failure must not take down the Shop report service.
  await creatorBudgetTest.initialize();
  await creatorWebBudget.initialize();
  await ppanCampaignActions.initialize();
  await fs.mkdir(config.reportOutputDir, { recursive: true });

  app.listen(config.port, () => {
    logger.info("gmv-max-report listening", {
      port: config.port,
      database: config.db.database,
      outputDir: config.reportOutputDir,
    });
  });

  startSyncCron();
}

main().catch((err) => {
  logger.error("Startup failed", { error: describeError(err) });
  process.exit(1);
});
