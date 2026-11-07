import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCreatorAutoBudgetService } from "./creatorAutoBudget.service";
import type { CreatorAutoBudgetGrant, CreatorAutoBudgetGrantRecord } from "./creatorAutoBudget.policy";
import { createCreatorWebBudgetService } from "./creatorWebBudget.service";
import type { WebBudgetContext, WebBudgetPolicy, WebBudgetRecord } from "./creatorWebBudget.service";

const now = new Date("2026-11-07T14:14:00.000Z");
const day = "2026-11-07";
const yesterday = "2026-11-06";
const campaignId = "1234567890123456";
const fingerprint = "a".repeat(64);
const ownerId = 23;
const operationId = randomUUID();
const input = { expectedCampaignId: campaignId, expectedBudgetMinor: 650_000, expectedPolicyRevision: 3,
  durationMinutes: 60, nativeAutoOff: true, noConcurrentChanges: true } as const;
const context: WebBudgetContext = {
  campaignId, reportingDate: day, observedAt: "2026-11-07T14:13:55.000Z", providerSpendObservedAt: "2026-11-07T14:12:00.000Z",
  budgetMinor: 650_000, spendMinor: 520_000, aggregateSpendMinor: 910_000, fingerprint,
  nativeAutoState: "DISABLED", deliveryVerified: true,
};
const policy: WebBudgetPolicy = {
  revision: 3, campaignCapMinor: 4_000_000, clientDailyCapMinor: 4_000_000,
  readAt: "2026-11-07T14:13:52.000Z", locked: false, autoLineReady: true,
};

type Dependencies = Parameters<typeof createCreatorAutoBudgetService>[0];
type Grants = Dependencies["grants"];
type Ledger = Dependencies["ledger"];
type Writer = Dependencies["writer"];

function fixture(initialMode: ReturnType<Dependencies["mode"]> = "shadow", snapshot: Partial<WebBudgetContext> = {}) {
  const contextValue = { ...context, ...snapshot };
  const saved = new Map<string, CreatorAutoBudgetGrantRecord>();
  const record = (grant: CreatorAutoBudgetGrant): CreatorAutoBudgetGrantRecord =>
    ({ ...grant, status: "ARMED", operationId: null, settledAt: null });
  const key = (client: string, date: string) => `${client}:${date}`;
  const grants = {
    ensureSchema: vi.fn<Grants["ensureSchema"]>(async () => undefined),
    get: vi.fn<Grants["get"]>(async (client, date) => saved.get(key(client, date)) ?? null),
    arm: vi.fn<Grants["arm"]>(async grant => {
      const slot = key(grant.clientId, grant.reportingDate);
      if (saved.has(slot)) return null;
      const row = record(grant);
      saved.set(slot, row);
      return row;
    }),
    reserve: vi.fn<Grants["reserve"]>(async (grant, id) => {
      const slot = key(grant.clientId, grant.reportingDate), existing = saved.get(slot);
      if (existing?.grantId !== grant.grantId || existing.status !== "ARMED") return null;
      const row = { ...existing, status: "RESERVED" as const, operationId: id };
      saved.set(slot, row);
      return row;
    }),
    isReserved: vi.fn<Grants["isReserved"]>(async (grant, id) => {
      const row = saved.get(key(grant.clientId, grant.reportingDate));
      return row?.grantId === grant.grantId && row.status === "RESERVED" && row.operationId === id;
    }),
    cancel: vi.fn<Grants["cancel"]>(async (client, date, id, owner) => {
      const slot = key(client, date), existing = saved.get(slot);
      if (existing?.grantId !== id || existing.ownerId !== owner) return null;
      const row = { ...existing, status: "REVOKED" as const };
      saved.set(slot, row);
      return row;
    }),
    close: vi.fn<Grants["close"]>(async (grant, id) => {
      const slot = key(grant.clientId, grant.reportingDate), existing = saved.get(slot);
      if (existing?.grantId !== grant.grantId || existing.operationId !== id) return null;
      const row = { ...existing, status: existing.status === "REVOKED" ? "REVOKED" as const : "COMPLETED" as const,
        settledAt: now.toISOString() };
      saved.set(slot, row);
      return row;
    }),
  };
  const proposed = {
    operationId, mode: "live" as const, campaignId, currentBudgetMinor: 650_000, targetBudgetMinor: 780_000,
    projectedClientSpendMinor: 1_170_000, cap: policy, expiresAt: "2026-11-07T14:16:00.000Z",
  };
  const ledger = {
    create: vi.fn<Ledger["create"]>(async () => undefined),
    get: vi.fn<Ledger["get"]>(async () => null),
    hasFence: vi.fn<Ledger["hasFence"]>(async () => false),
    reserve: vi.fn<Ledger["reserve"]>(async () => null),
    finish: vi.fn<Ledger["finish"]>(async () => { throw new Error("Unexpected ledger finish"); }),
  };
  const writer = {
    prepare: vi.fn<Writer["prepare"]>(async () => proposed),
    confirm: vi.fn<Writer["confirm"]>(async () => ({ operationId, status: "NOT_SENT", observedBudgetMinor: null })),
    status: vi.fn<Writer["status"]>(async () => ({ clientId: "punpan_020", mode: "live", cap: policy, capEditAllowed: true, canPrepare: true })),
    operation: vi.fn<Writer["operation"]>(async () => ({ operationId, status: "NOT_SENT", observedBudgetMinor: null })),
  };
  const adapters = {
    readContext: vi.fn<Dependencies["adapters"]["readContext"]>(async () => contextValue),
    readPolicy: vi.fn<Dependencies["adapters"]["readPolicy"]>(async () => policy),
    acquireLease: vi.fn<Dependencies["adapters"]["acquireLease"]>(async () => { throw new Error("Unexpected lease"); }),
    finishLease: vi.fn<Dependencies["adapters"]["finishLease"]>(async () => undefined),
    dispatch: vi.fn<Dependencies["adapters"]["dispatch"]>(async () => { throw new Error("Unexpected provider dispatch"); }),
  };
  const recheckOwner = vi.fn<Dependencies["recheckOwner"]>(async () => true);
  const discover = vi.fn<Dependencies["discover"]>(async () => campaignId);
  let mode = initialMode;
  const service = createCreatorAutoBudgetService({ clientId: "punpan_020", mode: () => mode, discover,
    adapters, grants, writer, ledger, recheckOwner, now: () => now });
  return { contextValue, service, grants, writer, ledger, adapters, recheckOwner, discover, proposed,
    setMode(value: typeof mode) { mode = value; },
    put(row: CreatorAutoBudgetGrantRecord) { saved.set(key("punpan_020", row.reportingDate), row); },
  };
}

describe("Creator automatic budget runner", () => {
  it("reports the shadow proposal and never arms, prepares, confirms, leases or dispatches", async () => {
    const h = fixture("shadow", { nativeAutoState: "UNKNOWN", providerSpendObservedAt: null, deliveryVerified: false });
    expect(await h.service.status(true)).toMatchObject({ mode: "shadow", grant: null,
      preview: { status: "WOULD_INCREASE", currentBudgetMinor: 650_000, targetBudgetMinor: 780_000, thresholdMinor: 520_000 },
      blockers: ["NATIVE_AUTO_UNVERIFIED", "SPEND_WATERMARK_MISSING", "LIVE_DELIVERY_UNVERIFIED"] });
    await expect(h.service.arm(ownerId, input, async () => true)).rejects.toMatchObject({ code: "AUTO_BUDGET_NOT_READY" });
    await h.service.tick();
    for (const call of [h.grants.arm, h.grants.reserve, h.writer.prepare, h.writer.confirm, h.adapters.acquireLease, h.adapters.dispatch]) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  it("cannot arm or dispatch in live mode without positive provider telemetry even with an authorized owner", async () => {
    for (const snapshot of [
      { nativeAutoState: "UNKNOWN" as const }, { providerSpendObservedAt: null }, { deliveryVerified: false },
      { providerSpendObservedAt: "2026-11-07T13:15:00.000Z", spendMinor: 300_000 },
    ]) {
      const h = fixture("live", snapshot);
      await expect(h.service.arm(ownerId, input, async () => true)).rejects.toMatchObject({ code: "AUTO_BUDGET_NOT_READY" });
      await h.service.tick();
      expect(h.grants.arm).not.toHaveBeenCalled();
      expect(h.writer.prepare).not.toHaveBeenCalled();
      expect(h.writer.confirm).not.toHaveBeenCalled();
    }
  });

  it("plans an exact synthetic 20% increase once and calls only the auto source under the exact durable grant", async () => {
    const h = fixture("live");
    const armed = await h.service.arm(ownerId, input, async () => true);
    expect(armed).toMatchObject({ grantId: expect.any(String), expiresAt: "2026-11-07T15:14:00.000Z" });
    h.writer.confirm.mockImplementation(async (id, confirmation, allowed, guard) => {
      expect(id).toBe(ownerId); expect(confirmation.operationId).toBe(operationId);
      expect(await allowed()).toBe(true);
      expect(await guard?.(context, policy)).toBe(true);
      expect(await guard?.({ ...context, spendMinor: 519_999 }, policy)).toBe(false);
      expect(await guard?.({ ...context, deliveryVerified: false }, policy)).toBe(false);
      expect(await guard?.(context, { ...policy, revision: 4 })).toBe(false);
      expect(await guard?.({ ...context, fingerprint: "b".repeat(64) }, policy)).toBe(false);
      return { operationId, status: "APPLIED_VERIFIED", observedBudgetMinor: 780_000 };
    });
    await h.service.tick(); await h.service.tick();
    expect(h.writer.prepare).toHaveBeenCalledTimes(1);
    expect(h.writer.prepare).toHaveBeenCalledWith(ownerId,
      { expectedCampaignId: campaignId, expectedBudgetMinor: 650_000, targetBudgetMinor: 780_000 }, "auto");
    expect(h.writer.confirm).toHaveBeenCalledTimes(1);
  });

  it("rechecks revocation before send and never applies a cross-Creator grant", async () => {
    const h = fixture("live");
    const armed = await h.service.arm(ownerId, input, async () => true);
    h.writer.confirm.mockImplementation(async (_id, _confirmation, allowed, guard) => {
      await h.service.stop(ownerId, armed.grantId);
      expect(await allowed()).toBe(false);
      expect(await guard?.(context, policy)).toBe(false);
      return { operationId, status: "NOT_SENT", observedBudgetMinor: null };
    });
    await h.service.tick(); await h.service.tick();
    expect(h.writer.prepare).toHaveBeenCalledTimes(1);
    expect(h.writer.confirm).toHaveBeenCalledTimes(1);

    const other = fixture("live");
    await other.service.arm(ownerId, input, async () => true);
    const row = other.grants.arm.mock.calls[0][0];
    other.put({ ...row, clientId: "srihiw", status: "ARMED", operationId: null });
    await other.service.tick();
    expect(other.writer.prepare).not.toHaveBeenCalled();
  });

  it("recovers only a proven auto ledger result to LINE, never replaying the TikTok operation", async () => {
    const h = fixture("live");
    await h.service.arm(ownerId, input, async () => true);
    const row = h.grants.arm.mock.calls[0][0];
    h.put({ ...row, status: "REVOKED", operationId, settledAt: null });
    const ledger: WebBudgetRecord = { ...h.proposed, source: "auto", status: "APPLIED_VERIFIED", ownerId,
      observedBudgetMinor: 780_000, fingerprint, reportingDate: day };
    h.ledger.get.mockResolvedValue({ ...ledger, source: "manual" });
    await h.service.tick();
    expect(h.adapters.finishLease).not.toHaveBeenCalled();
    h.ledger.get.mockResolvedValue({ ...ledger, status: "OUTCOME_UNKNOWN", observedBudgetMinor: null });
    await h.service.tick();
    expect(h.adapters.finishLease).not.toHaveBeenCalled();
    h.ledger.get.mockResolvedValue(ledger);
    h.adapters.finishLease.mockRejectedValueOnce(new Error("uncertain network"));
    await expect(h.service.tick()).rejects.toThrow("uncertain network");
    expect(h.grants.close).not.toHaveBeenCalled();
    await h.service.tick(); await h.service.tick();
    expect(h.adapters.finishLease).toHaveBeenCalledTimes(2);
    expect(h.adapters.finishLease).toHaveBeenCalledWith(operationId, "APPLIED_VERIFIED");
    expect(h.grants.close).toHaveBeenCalledTimes(1);
    for (const call of [h.writer.prepare, h.writer.confirm, h.adapters.acquireLease, h.adapters.dispatch]) expect(call).not.toHaveBeenCalled();
  });

  it("checks the previous Thai day's unsettled notification and can do so while in shadow mode", async () => {
    const h = fixture("live");
    await h.service.arm(ownerId, input, async () => true);
    const row = h.grants.arm.mock.calls[0][0];
    h.put({ ...row, reportingDate: yesterday, authorizedAt: "2026-11-06T14:14:00.000Z",
      expiresAt: "2026-11-06T15:14:00.000Z", status: "RESERVED", operationId, settledAt: null });
    h.setMode("shadow");
    h.ledger.get.mockResolvedValue({ ...h.proposed, source: "auto", status: "APPLIED_VERIFIED", ownerId,
      observedBudgetMinor: 780_000, fingerprint, reportingDate: yesterday });
    await h.service.tick();
    expect(h.adapters.finishLease).toHaveBeenCalledWith(operationId, "APPLIED_VERIFIED");
    expect(h.writer.prepare).not.toHaveBeenCalled();
  });

  it("rejects manual confirmation of an auto-prepared operation and auto confirmation of a manual operation", async () => {
    const h = fixture("live");
    const shared = createCreatorWebBudgetService({ store: h.ledger, adapters: h.adapters, mode: () => "live", now: () => now });
    const base: WebBudgetRecord = { ...h.proposed, source: "auto", status: "PREPARED", ownerId,
      observedBudgetMinor: null, fingerprint, reportingDate: day };
    const intent = { operationId, nativeAutoOff: true, noConcurrentChanges: true } as const;
    h.ledger.get.mockResolvedValue(base);
    await expect(shared.confirm(ownerId, intent, async () => true)).rejects.toMatchObject({ code: "BUDGET_OPERATION_NOT_FOUND" });
    h.ledger.get.mockResolvedValue({ ...base, source: "manual" });
    await expect(shared.confirm(ownerId, intent, async () => true, async () => true))
      .rejects.toMatchObject({ code: "BUDGET_OPERATION_NOT_FOUND" });
    expect(h.ledger.reserve).not.toHaveBeenCalled();
    expect(h.adapters.acquireLease).not.toHaveBeenCalled();
    expect(h.adapters.dispatch).not.toHaveBeenCalled();
  });
});
