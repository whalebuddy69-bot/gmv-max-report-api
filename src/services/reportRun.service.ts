import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { API_LIMITS, config } from "../config";
import { AppDataSource } from "../db/dataSource";
import { ReportRun } from "../entities/ReportRun";
import { NotFoundError, ValidationError, describeError } from "../utils/errors";
import { logger } from "../utils/logger";
import { writeReportWorkbook } from "./excelExport.service";
import { buildReport } from "./reportBuilder.service";
import { resolveStore } from "./store.service";
import { TikTokApiService } from "./tiktokApi.service";
import { getAccessTokenForAdvertiser } from "./token.service";

/** Runs one report end to end and records it in report_runs. */

export interface GenerateReportInput {
  advertiserId: string;
  storeId: string;
  startDate: string;
  endDate: string;
  /** Optional override; normally resolved from /gmv_max/store/list/. */
  storeAuthorizedBcId?: string;
  /** Restrict to these campaigns. Default: every campaign with cost > 0 in the window. */
  campaignIds?: string[];
  /** Keep creatives with no cost and no orders. Default false. */
  includeZeroCost?: boolean;
}

export interface GenerateReportResult {
  runId: string;
  filePath: string;
  fileName: string;
  warnings: string[];
  stats: Record<string, number>;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function generateReport(input: GenerateReportInput): Promise<GenerateReportResult> {
  validateDateRange(input.startDate, input.endDate);

  const runs = AppDataSource.getRepository(ReportRun);
  const run = runs.create({
    id: randomUUID(),
    advertiserId: input.advertiserId,
    storeIds: [input.storeId],
    startDate: input.startDate,
    endDate: input.endDate,
    status: "pending",
  });
  await runs.save(run);

  logger.info("Report run started", {
    runId: run.id,
    advertiserId: input.advertiserId,
    storeId: input.storeId,
    range: `${input.startDate}..${input.endDate}`,
  });

  try {
    const accessToken = await getAccessTokenForAdvertiser(input.advertiserId);
    const api = new TikTokApiService(accessToken, input.advertiserId);

    const store = await resolveStore(api, input);

    const report = await buildReport(api, store.context, {
      startDate: input.startDate,
      endDate: input.endDate,
      campaignIds: input.campaignIds,
      includeZeroCost: input.includeZeroCost,
    });
    report.warnings.unshift(...store.warnings);

    const generatedAt = new Date();
    const fileName = buildFileName(input, run.id);
    const filePath = path.join(config.reportOutputDir, fileName);
    await fs.mkdir(config.reportOutputDir, { recursive: true });

    await writeReportWorkbook(
      report,
      {
        advertiserId: input.advertiserId,
        storeId: input.storeId,
        storeName: store.storeName,
        startDate: input.startDate,
        endDate: input.endDate,
        generatedAt,
      },
      filePath
    );

    run.status = "success";
    run.filePath = filePath;
    run.fileName = fileName;
    run.rowCounts = {
      campaigns: report.stats.campaignsReported,
      products: report.stats.products,
      creatives: report.stats.creatives,
      productCards: report.stats.productCards,
      rowsWithAccountName: report.stats.rowsWithAccountName,
    };
    run.warnings = report.warnings;
    run.generatedAt = generatedAt;
    await runs.save(run);

    logger.info("Report run finished", { runId: run.id, fileName, ...report.stats });

    return {
      runId: run.id,
      filePath,
      fileName,
      warnings: report.warnings,
      stats: report.stats as unknown as Record<string, number>,
    };
  } catch (err) {
    run.status = "failed";
    run.errorMessage = describeError(err);
    await runs.save(run).catch((saveErr) => {
      logger.error("Could not record failed run", { runId: run.id, error: describeError(saveErr) });
    });
    logger.error("Report run failed", { runId: run.id, error: describeError(err) });
    throw err;
  }
}

/** Backing lookup for GET /reports/:id/download. */
export async function getCompletedRunFile(runId: string): Promise<{ filePath: string; fileName: string }> {
  const run = await AppDataSource.getRepository(ReportRun).findOne({ where: { id: runId } });

  if (!run) throw new NotFoundError(`ไม่พบ report run ${runId}`);
  if (run.status !== "success" || !run.filePath || !run.fileName) {
    throw new NotFoundError(`report run ${runId} ยังไม่มีไฟล์ (status=${run.status})`, {
      status: run.status,
      error: run.errorMessage ?? undefined,
    });
  }

  // only serve files inside the output dir
  const resolved = path.resolve(run.filePath);
  if (!resolved.startsWith(config.reportOutputDir + path.sep)) {
    throw new NotFoundError(`report run ${runId} ชี้ไปยังไฟล์นอก REPORT_OUTPUT_DIR`);
  }

  try {
    await fs.access(resolved);
  } catch {
    throw new NotFoundError(
      `ไฟล์ของ report run ${runId} ไม่อยู่บนดิสก์แล้ว (${run.fileName}), สั่งสร้างรายงานใหม่อีกครั้ง`
    );
  }

  return { filePath: resolved, fileName: run.fileName };
}

function validateDateRange(startDate: string, endDate: string): void {
  if (!DATE_PATTERN.test(startDate) || !DATE_PATTERN.test(endDate)) {
    throw new ValidationError("startDate และ endDate ต้องอยู่ในรูปแบบ YYYY-MM-DD");
  }

  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new ValidationError("startDate หรือ endDate ไม่ใช่วันที่ที่ถูกต้อง");
  }
  if (start > end) {
    throw new ValidationError("startDate ต้องไม่เกิน endDate");
  }

  const days = Math.floor((end - start) / 86_400_000) + 1;
  if (days > API_LIMITS.maxReportDays) {
    throw new ValidationError(
      `ช่วงวันที่ยาว ${days} วัน, /gmv_max/report/get/ รองรับได้สูงสุด ${API_LIMITS.maxReportDays} วันต่อครั้ง`
    );
  }
}

function buildFileName(input: GenerateReportInput, runId: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "");
  return `gmv-max-report_${safe(input.storeId)}_${input.startDate}_${input.endDate}_${runId.slice(0, 8)}.xlsx`;
}
