import { z } from "zod";

/** Explicit history requests are always restricted to exactly one shop. */
export const syncRunSchema = z.object({
  advertiserId: z.string().trim().min(1).optional(),
  storeId: z.string().trim().min(1).optional(),
  lookbackDays: z.number().int().min(1).max(62).optional(),
  initialHistory: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  if (Boolean(value.advertiserId) !== Boolean(value.storeId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ต้องระบุ advertiserId และ storeId คู่กัน" });
  }
  if ((value.lookbackDays !== undefined || value.initialHistory === true) && !value.storeId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "การดึงย้อนหลังต้องระบุร้านเดียว" });
  }
  if (value.initialHistory === true && value.lookbackDays !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "เลือก lookbackDays หรือ initialHistory อย่างใดอย่างหนึ่ง" });
  }
});
