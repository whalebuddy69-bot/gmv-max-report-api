import "reflect-metadata";
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import fs from "fs/promises";
import { config } from "./config";
import { AppDataSource } from "./db/dataSource";
import { analyticsRouter } from "./routes/analytics.route";
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

const app = express();

app.use(
  cors({
    origin: config.corsOrigins.includes("*") ? true : config.corsOrigins,
    credentials: true,
  })
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, db: AppDataSource.isInitialized });
});

// web app (JWT)
app.use("/auth", authRouter);
app.use("/analytics", analyticsRouter);
app.use("/users", usersRouter);

// TikTok OAuth redirect (no auth)
app.use("/oauth", oauthRouter);

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
