/** TikTok delivery states, not Exploration/Outstanding quality classifications. */
export const CREATIVE_DELIVERY_STATUSES = [
  "IN_QUEUE", "LEARNING", "DELIVERING", "NOT_DELIVERYING", "AUTHORIZATION_NEEDED",
  "EXCLUDED", "UNAVAILABLE", "REJECTED", "NOT_ACTIVE",
] as const;

/** Unknown and future values remain visible rather than being silently discarded. */
export const CREATIVE_DELIVERY_STATUS_FILTERS = [...CREATIVE_DELIVERY_STATUSES, "UNKNOWN", "OTHER"] as const;
export type CreativeDeliveryStatusFilter = typeof CREATIVE_DELIVERY_STATUS_FILTERS[number];
export type CreativeDeliveryStatusCounts = Record<CreativeDeliveryStatusFilter, number>;

export function completeStatusCounts(counts: Partial<Record<CreativeDeliveryStatusFilter, unknown>> = {}): CreativeDeliveryStatusCounts {
  return Object.fromEntries(CREATIVE_DELIVERY_STATUS_FILTERS.map((status) => [status, Number(counts[status] ?? 0)])) as CreativeDeliveryStatusCounts;
}

/** The argument is an internal SQL column expression, never user input. Raw status is preserved separately. */
export function deliveryStatusBucketSql(column: string): string {
  return `CASE
    WHEN ${column} IS NULL OR regexp_replace(${column}, '^[[:space:]]+|[[:space:]]+$', '', 'g') IN ('', '-', '0', '-1') THEN 'UNKNOWN'
    WHEN ${column} IN (${CREATIVE_DELIVERY_STATUSES.map((status) => `'${status}'`).join(", ")}) THEN ${column}
    ELSE 'OTHER'
  END`;
}
