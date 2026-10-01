import { Router } from "express";
import { z } from "zod";
import { listStoresForAdvertiser } from "../services/store.service";
import { ValidationError } from "../utils/errors";

const listSchema = z.object({
  advertiserId: z.string().min(1),
});

export const storesRouter = Router();

/** GET /stores?advertiserId=...: GMV Max available shops first. */
storesRouter.get("/", async (req, res, next) => {
  try {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError("ต้องระบุ advertiserId ใน query string", {
        issues: parsed.error.issues,
      });
    }

    const stores = await listStoresForAdvertiser(parsed.data.advertiserId);
    res.json({
      advertiserId: parsed.data.advertiserId,
      count: stores.length,
      gmvMaxAvailableCount: stores.filter((s) => s.isGmvMaxAvailable).length,
      stores,
    });
  } catch (err) {
    next(err);
  }
});
