import { z } from "zod";
import { ValidationError } from "../utils/errors";

const promotionTypeSchema = z.object({
  promotionType: z.enum(["PRODUCT", "LIVE", "ALL"]).default("PRODUCT"),
});

/** PRODUCT | LIVE | ALL, default PRODUCT. Anything else is a 400. */
export function parsePromotionType(query: unknown): "PRODUCT" | "LIVE" | "ALL" {
  const parsed = promotionTypeSchema.safeParse(query);
  if (!parsed.success) {
    throw new ValidationError("promotionType ต้องเป็น PRODUCT, LIVE หรือ ALL เท่านั้น", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data.promotionType;
}
