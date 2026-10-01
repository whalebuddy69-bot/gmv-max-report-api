import { Router } from "express";
import { z } from "zod";
import { ValidationError } from "../utils/errors";
import { generateReport, getCompletedRunFile } from "../services/reportRun.service";

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const generateSchema = z.object({
  advertiserId: z.string().min(1),
  storeId: z.string().min(1),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ต้องเป็น YYYY-MM-DD"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ต้องเป็น YYYY-MM-DD"),
  storeAuthorizedBcId: z.string().min(1).optional(),
  /** Omit to report every campaign that spent anything in the window. */
  campaignIds: z.array(z.string().min(1)).optional(),
  includeZeroCost: z.boolean().optional(),
});

export const reportsRouter = Router();

/**
 * POST /reports/generate
 * Builds the workbook and returns it directly (can be slow). Warnings are also sent as
 * response headers.
 */
reportsRouter.post("/generate", async (req, res, next) => {
  try {
    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("request body ไม่ถูกต้อง", { issues: parsed.error.issues });
    }

    const result = await generateReport(parsed.data);

    res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
    res.setHeader("Content-Disposition", `attachment; filename="${result.fileName}"`);
    res.setHeader("X-Report-Run-Id", result.runId);
    res.setHeader("X-Report-Warning-Count", String(result.warnings.length));

    res.sendFile(result.filePath, (err) => {
      if (err) next(err);
    });
  } catch (err) {
    next(err);
  }
});

/** GET /reports/:id/download: download a previously generated file. */
reportsRouter.get("/:id/download", async (req, res, next) => {
  try {
    const { filePath, fileName } = await getCompletedRunFile(req.params.id);

    res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.sendFile(filePath, (err) => {
      if (err) next(err);
    });
  } catch (err) {
    next(err);
  }
});
