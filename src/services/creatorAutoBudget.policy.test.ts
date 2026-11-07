import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { bangkokDay } from "./creatorRead.service";
import {
  createCreatorAutoBudgetGrantStore, evaluateCreatorAutoBudget, previewCreatorAutoBudget,
  type CreatorAutoBudgetContext, type CreatorAutoBudgetGrant, type CreatorAutoBudgetGrantRecord,
} from "./creatorAutoBudget.policy";
import type { WebBudgetPolicy } from "./creatorWebBudget.service";

const AT = new Date("2026-11-07T14:14:00.000Z");
const DAY = "2026-11-07";
const CAMPAIGN = "1234567890123456";
const FINGERPRINT = "b".repeat(64);
const grant: CreatorAutoBudgetGrantRecord = {
  grantId: randomUUID(), ownerId: 12, clientId: "punpan_020", reportingDate: DAY, campaignId: CAMPAIGN,
  expectedBudgetMinor: 650_000, policyRevision: 3, fingerprint: FINGERPRINT,
  authorizedAt: "2026-11-07T14:00:00.000Z", expiresAt: "2026-11-07T15:00:00.000Z",
  nativeAutoOffAttested: true, noConcurrentChangesAttested: true, status: "ARMED", operationId: null,
};
const context: CreatorAutoBudgetContext = {
  campaignId: CAMPAIGN, reportingDate: DAY, fingerprint: FINGERPRINT, nativeAutoState: "DISABLED",
  observedAt: "2026-11-07T14:13:55.000Z", providerSpendObservedAt: "2026-11-07T14:13:10.000Z",
  budgetMinor: 650_000, spendMinor: 520_000, aggregateSpendMinor: 910_000, deliveryVerified: true,
};
const policy: WebBudgetPolicy = {
  revision: 3, campaignCapMinor: 4_000_000, clientDailyCapMinor: 4_000_000,
  readAt: "2026-11-07T14:13:52.000Z", locked: false,
};
const args: Parameters<typeof evaluateCreatorAutoBudget>[0] = {
  clientId: "punpan_020", now: AT, grant, context, policy, hasUnresolvedWrite: false, notificationReady: true,
};

describe("Creator Auto 80% → 20% policy", () => {
  it("uses the exact latest budget and accepts the threshold boundary without exceeding the cap", () => {
    expect(evaluateCreatorAutoBudget(args)).toEqual({
      status: "ELIGIBLE", currentBudgetMinor: 650_000, targetBudgetMinor: 780_000, thresholdMinor: 520_000,
      projectedClientSpendMinor: 1_170_000, fingerprint: FINGERPRINT, expiresAt: "2026-11-07T14:16:00.000Z",
    });
    expect(evaluateCreatorAutoBudget({ ...args, context: { ...context, spendMinor: 519_999 } }))
      .toEqual({ status: "BELOW_THRESHOLD" });
    expect(evaluateCreatorAutoBudget({ ...args, policy: { ...policy, campaignCapMinor: 780_000, clientDailyCapMinor: 1_170_000 } }))
      .toMatchObject({ status: "ELIGIBLE" });
  });

  it("never rounds or clamps and enforces the target and aggregate limits separately", () => {
    expect(previewCreatorAutoBudget({ now: AT, context: { ...context, budgetMinor: 650_001, spendMinor: 520_001 }, policy }))
      .toEqual({ status: "TARGET_NOT_EXACT" });
    expect(evaluateCreatorAutoBudget({ ...args, context: { ...context, spendMinor: 780_000 } }))
      .toEqual({ status: "TARGET_BELOW_SPEND" });
    expect(evaluateCreatorAutoBudget({ ...args, policy: { ...policy, campaignCapMinor: 779_999 } }))
      .toEqual({ status: "CAMPAIGN_CAP_EXCEEDED" });
    expect(evaluateCreatorAutoBudget({ ...args, policy: { ...policy, clientDailyCapMinor: 1_169_999 } }))
      .toEqual({ status: "CLIENT_DAILY_CAP_EXCEEDED" });
  });

  it("keeps shadow advisory even when delivery, native setting and report freshness are unknown", () => {
    const weak: CreatorAutoBudgetContext = { ...context, nativeAutoState: "UNKNOWN", providerSpendObservedAt: null, deliveryVerified: undefined };
    expect(previewCreatorAutoBudget({ now: AT, context: weak, policy })).toMatchObject({ status: "WOULD_INCREASE", targetBudgetMinor: 780_000 });
    expect(evaluateCreatorAutoBudget({ ...args, context: weak })).toEqual({ status: "NATIVE_AUTO_UNVERIFIED" });
    for (const state of ["UNKNOWN", "ENABLED", "CONFLICT"] as const) {
      expect(evaluateCreatorAutoBudget({ ...args, context: { ...context, nativeAutoState: state } })).toEqual({ status: "NATIVE_AUTO_UNVERIFIED" });
    }
    for (const watermark of [null, "2026-11-07T14:08:59.999Z", "2026-11-07T14:13:56.000Z", "yesterday"]) {
      expect(evaluateCreatorAutoBudget({ ...args, context: { ...context, providerSpendObservedAt: watermark } }))
        .toEqual({ status: "PROVIDER_SPEND_STALE" });
    }
    expect(evaluateCreatorAutoBudget({ ...args, context: { ...context, deliveryVerified: false } })).toEqual({ status: "DELIVERY_UNVERIFIED" });
    expect(evaluateCreatorAutoBudget({ ...args, context: { ...context, spendMinor: 300_000, providerSpendObservedAt: "2026-11-07T14:07:00.000Z" } }))
      .toEqual({ status: "PROVIDER_SPEND_STALE" });
    expect(evaluateCreatorAutoBudget({ ...args, notificationReady: false })).toEqual({ status: "NOTIFICATION_UNAVAILABLE" });
  });

  it("fails closed for stale report fetch, stale cap, incomplete totals, locks or uncertain other writes", () => {
    expect(previewCreatorAutoBudget({ now: AT, policy, context: { ...context, observedAt: "2026-11-07T14:13:29.999Z" } }))
      .toEqual({ status: "CONTEXT_UNVERIFIED" });
    expect(previewCreatorAutoBudget({ now: AT, policy: { ...policy, readAt: "2026-11-07T14:13:39.999Z" }, context }))
      .toEqual({ status: "POLICY_UNAVAILABLE" });
    expect(evaluateCreatorAutoBudget({ ...args, context: { ...context, aggregateSpendMinor: 519_999 } }))
      .toEqual({ status: "CONTEXT_UNVERIFIED" });
    expect(evaluateCreatorAutoBudget({ ...args, policy: { ...policy, locked: true } })).toEqual({ status: "POLICY_LOCKED" });
    expect(evaluateCreatorAutoBudget({ ...args, hasUnresolvedWrite: true })).toEqual({ status: "UNRESOLVED_WRITE" });
  });

  it("requires the exact Creator, grant window, budget fingerprint, campaign and cap revision", () => {
    expect(evaluateCreatorAutoBudget({ ...args, grant: null })).toEqual({ status: "NOT_ARMED" });
    expect(evaluateCreatorAutoBudget({ ...args, clientId: "srihiw" })).toEqual({ status: "NOT_ARMED" });
    for (const status of ["RESERVED", "REVOKED", "COMPLETED"] as const) {
      expect(evaluateCreatorAutoBudget({ ...args, grant: { ...grant, status } })).toEqual({ status: "NOT_ARMED" });
    }
    expect(evaluateCreatorAutoBudget({ ...args, grant: { ...grant, expiresAt: "2026-11-07T14:14:14.999Z" } }))
      .toEqual({ status: "GRANT_EXPIRED" });
    expect(evaluateCreatorAutoBudget({ ...args, grant: { ...grant, expiresAt: "2026-11-07T16:00:00.001Z" } }))
      .toEqual({ status: "NOT_ARMED" });
    expect(evaluateCreatorAutoBudget({ ...args, now: new Date("2026-11-07T17:00:00.000Z") })).toEqual({ status: "GRANT_EXPIRED" });
    expect(evaluateCreatorAutoBudget({ ...args, policy: { ...policy, revision: 4 } })).toEqual({ status: "BASELINE_CHANGED" });
    for (const snapshot of [
      { ...context, campaignId: "1234567890123457" }, { ...context, budgetMinor: 645_000 }, { ...context, fingerprint: "e".repeat(64) },
    ]) expect(evaluateCreatorAutoBudget({ ...args, context: snapshot })).toEqual({ status: "BASELINE_CHANGED" });
  });
});

const dbs: PGlite[] = [];
afterEach(async () => { for (const db of dbs.splice(0)) await db.close(); });
function setup() {
  const db = new PGlite(); dbs.push(db);
  const calls: string[] = [];
  const database = { createQueryRunner: () => ({ connect: async () => undefined, release: async () => undefined,
    query: async (sql: string, params?: unknown[]) => {
      calls.push(sql);
      if (sql.includes("CREATE TABLE")) { await db.exec(sql); return []; }
      const result = await db.query(sql, params);
      return sql.trimStart().startsWith("UPDATE") ? [result.rows, result.affectedRows ?? 0] : result.rows;
    } }) };
  return { db, calls, database, store: createCreatorAutoBudgetGrantStore(database) };
}
function liveGrant(overrides: Partial<CreatorAutoBudgetGrant> = {}): CreatorAutoBudgetGrant {
  const now = new Date(), day = bangkokDay(now);
  const midnight = Date.parse(`${day}T00:00:00+07:00`) + 86_400_000;
  return {
    grantId: randomUUID(), clientId: "punpan_020", ownerId: 12, campaignId: CAMPAIGN, reportingDate: day,
    policyRevision: 3, expectedBudgetMinor: 650_000, fingerprint: FINGERPRINT,
    authorizedAt: now.toISOString(), expiresAt: new Date(Math.min(midnight, now.getTime() + 30 * 60_000)).toISOString(),
    nativeAutoOffAttested: true, noConcurrentChangesAttested: true, ...overrides,
  };
}

describe("Creator Auto durable one-shot grant", () => {
  it("only bootstraps explicitly and commits one immutable grant per Creator/day", async () => {
    const h = setup();
    const { clientId, reportingDate } = liveGrant();
    await expect(h.store.get(clientId, reportingDate)).rejects.toThrow("AUTO_BUDGET_GRANT_STORE_UNAVAILABLE");
    expect(h.calls.some(sql => /CREATE TABLE/.test(sql))).toBe(false);
    await h.store.ensureSchema(); await h.store.ensureSchema();
    const first = liveGrant();
    expect(await h.store.arm(first)).toEqual({ ...first, status: "ARMED", operationId: null, settledAt: null });
    expect(h.calls.at(-1)).toBe("COMMIT");
    const next = createCreatorAutoBudgetGrantStore(h.database);
    expect(await next.arm(liveGrant({ ownerId: 22 }))).toBeNull();
    expect(await next.get(first.clientId, first.reportingDate)).toMatchObject(first);
    expect(await next.arm(liveGrant({ clientId: "srihiw" }))).toMatchObject({ clientId: "srihiw", status: "ARMED" });
  });

  it("reserves once across workers; only an exact stored grant and operation can pass the send recheck", async () => {
    const h = setup(); await h.store.ensureSchema();
    const g = liveGrant(), op = randomUUID(), wrongOp = randomUUID();
    await h.store.arm(g);
    const next = createCreatorAutoBudgetGrantStore(h.database);
    expect(await next.reserve({ ...g, ownerId: 17 }, op)).toBeNull();
    expect(await next.reserve({ ...g, fingerprint: "c".repeat(64) }, op)).toBeNull();
    expect(await next.reserve({ ...g, expectedBudgetMinor: 700_000 }, op)).toBeNull();
    expect(await next.reserve({ ...g, policyRevision: 4 }, op)).toBeNull();
    expect(await next.reserve(g, op)).toMatchObject({ status: "RESERVED", operationId: op });
    expect(h.calls.at(-1)).toBe("COMMIT");
    expect(await h.store.reserve(g, wrongOp)).toBeNull();
    expect(await h.store.isReserved(g, wrongOp)).toBe(false);
    expect(await h.store.isReserved(g, op)).toBe(true);
    expect(await h.store.close(g, wrongOp)).toBeNull();
    const done = await h.store.close(g, op);
    expect(done).toMatchObject({ status: "COMPLETED", operationId: op, settledAt: expect.any(String) });
    expect(await next.close(g, op)).toEqual(done);
    expect(await next.isReserved(g, op)).toBe(false);
    expect(await next.reserve(g, op)).toBeNull();
  });

  it("cancels the send gate after reservation without losing operation evidence or releasing the daily allowance", async () => {
    const h = setup(); await h.store.ensureSchema();
    const g = liveGrant(), op = randomUUID();
    await h.store.arm(g); await h.store.reserve(g, op);
    expect(await h.store.cancel(g.clientId, g.reportingDate, g.grantId, g.ownerId + 1)).toBeNull();
    expect(await h.store.isReserved(g, op)).toBe(true);
    expect(await h.store.cancel(g.clientId, g.reportingDate, g.grantId, g.ownerId))
      .toMatchObject({ status: "REVOKED", operationId: op, settledAt: null });
    expect(await h.store.isReserved(g, op)).toBe(false);
    expect(await h.store.arm(liveGrant())).toBeNull();
    expect(await h.store.close(g, op)).toMatchObject({ status: "REVOKED", operationId: op, settledAt: expect.any(String) });
  });

  it("rejects out-of-scope, stale and cross-Bangkok-day permits", async () => {
    const h = setup(); await h.store.ensureSchema();
    const now = new Date();
    const stale = liveGrant({ authorizedAt: new Date(now.getTime() - 31_000).toISOString() });
    expect(await h.store.arm(stale)).toBeNull();
    expect(await h.store.arm(liveGrant({ reportingDate: "2026-02-31" }))).toBeNull();
    expect(await h.store.arm(liveGrant({ expiresAt: new Date(now.getTime() + 7_300_000).toISOString() }))).toBeNull();
    expect(await h.store.arm(liveGrant({ clientId: "other" as CreatorAutoBudgetGrant["clientId"] }))).toBeNull();
    expect(await h.store.arm(liveGrant({ nativeAutoOffAttested: false as true }))).toBeNull();
    const almostMidnight = liveGrant({
      reportingDate: "2026-11-07", authorizedAt: "2026-11-07T16:59:00.000Z", expiresAt: "2026-11-07T17:01:00.000Z",
    });
    expect(await h.store.arm(almostMidnight)).toBeNull();
  });
});
