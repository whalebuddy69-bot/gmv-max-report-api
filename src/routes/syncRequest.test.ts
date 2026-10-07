import { describe, expect, it } from "vitest";
import { syncRunSchema } from "./syncRequest";

const shop = { advertiserId: "7509010106013581313", storeId: "7494779514917587663" };

describe("sync request history scope", () => {
  it("keeps the existing all-shop rolling request and one-shop default", () => {
    expect(syncRunSchema.parse({})).toEqual({});
    expect(syncRunSchema.parse(shop)).toEqual(shop);
  });
  it("allows explicit 30 days, previous-month history and bounded 62 days", () => {
    for (const options of [{ lookbackDays: 30 }, { lookbackDays: 62 }, { initialHistory: true }]) {
      expect(syncRunSchema.parse({ ...shop, ...options })).toEqual({ ...shop, ...options });
    }
  });
  it.each([{ storeId: shop.storeId }, { advertiserId: shop.advertiserId }, { lookbackDays: 30 }, { initialHistory: true }])(
    "rejects incomplete shop scope instead of silently starting every shop: %j", (body) => {
      expect(syncRunSchema.safeParse(body).success).toBe(false);
    },
  );
  it.each([0, -1, 63, 1.5, "30", null])("rejects invalid lookback %j", (lookbackDays) => {
    expect(syncRunSchema.safeParse({ ...shop, lookbackDays }).success).toBe(false);
  });
  it("rejects competing policies and misspelled options", () => {
    expect(syncRunSchema.safeParse({ ...shop, lookbackDays: 30, initialHistory: true }).success).toBe(false);
    expect(syncRunSchema.safeParse({ ...shop, initialHisotry: true }).success).toBe(false);
    expect(syncRunSchema.safeParse({ ...shop, initialHistory: "true" }).success).toBe(false);
  });
  it("lets false history retain explicit rolling behavior", () => {
    expect(syncRunSchema.parse({ ...shop, lookbackDays: 3, initialHistory: false }).lookbackDays).toBe(3);
  });
});
