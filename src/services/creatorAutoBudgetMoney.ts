/** Monetary math shared by Auto previews, authorization, and the write guard. */
export type CreatorAutoBudgetRounding = "floor-satang" | "ceil-baht";

export function roundedCreatorAutoTarget(baselineMinor: bigint, rounding?: CreatorAutoBudgetRounding): bigint | null {
  if (baselineMinor <= 0n) return null;
  const scaled = baselineMinor * 6n; // Exact +20%, with denominator 5.
  if (rounding === "ceil-baht") return ((scaled + 499n) / 500n) * 100n;
  if (rounding === "floor-satang") return scaled / 5n;
  return rounding === undefined && scaled % 5n === 0n ? scaled / 5n : null;
}
