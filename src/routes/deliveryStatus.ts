import { z } from "zod";
import { CREATIVE_DELIVERY_STATUS_FILTERS, CreativeDeliveryStatusFilter } from "../services/creativeDeliveryStatus";
import { ValidationError } from "../utils/errors";

const schema = z.object({ deliveryStatus: z.enum(CREATIVE_DELIVERY_STATUS_FILTERS).optional() });

/** Omitted means all; repeated, malformed or unrecognized filters are a 400. */
export function parseDeliveryStatus(query: unknown): CreativeDeliveryStatusFilter | undefined {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    throw new ValidationError("deliveryStatus ต้องเป็นสถานะที่รองรับ, UNKNOWN หรือ OTHER เท่านั้น", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data.deliveryStatus;
}
