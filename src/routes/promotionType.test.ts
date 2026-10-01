import { describe, expect, it } from "vitest";
import { parsePromotionType } from "./promotionType";
import { ValidationError } from "../utils/errors";

describe("parsePromotionType", () => {
  it("defaults to PRODUCT when the query has no promotionType at all", () => {
    expect(parsePromotionType({})).toBe("PRODUCT");
  });

  it("accepts LIVE and ALL", () => {
    expect(parsePromotionType({ promotionType: "LIVE" })).toBe("LIVE");
    expect(parsePromotionType({ promotionType: "ALL" })).toBe("ALL");
  });

  it("rejects an invalid value with a ValidationError (400) instead of a silent fallback", () => {
    expect(() => parsePromotionType({ promotionType: "live" })).toThrow(ValidationError);
    expect(() => parsePromotionType({ promotionType: "PRODUCT_GMV_MAX" })).toThrow(ValidationError);
    expect(() => parsePromotionType({ promotionType: "" })).toThrow(ValidationError);
  });
});
