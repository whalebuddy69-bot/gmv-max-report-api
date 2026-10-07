import { describe, expect, it } from "vitest";
import { CREATIVE_DELIVERY_STATUS_FILTERS } from "../services/creativeDeliveryStatus";
import { ValidationError } from "../utils/errors";
import { parseDeliveryStatus } from "./deliveryStatus";

describe("parseDeliveryStatus", () => {
  it("leaves omitted status unfiltered", () => {
    expect(parseDeliveryStatus({ from: "2026-10-01" })).toBeUndefined();
  });

  it.each(CREATIVE_DELIVERY_STATUS_FILTERS)("accepts %s", (deliveryStatus) => {
    expect(parseDeliveryStatus({ deliveryStatus })).toBe(deliveryStatus);
  });

  it.each(["", "delivering", "NOT_DELIVERING", "FUTURE_STATUS", "DELIVERING' OR 1=1; --", ["LEARNING", "DELIVERING"], {}, null, 0])("rejects invalid input %j as a 400", (deliveryStatus) => {
    try {
      parseDeliveryStatus({ deliveryStatus });
      expect.fail("Expected validation to reject invalid status");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ httpStatus: 400, code: "VALIDATION_ERROR" });
    }
  });
});
