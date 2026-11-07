import { describe, expect, it, vi } from "vitest";
import {
  createCreatorWebBudgetService, WebBudgetAdapters, WebBudgetMode, WebBudgetRecord, WebBudgetStore,
} from "./creatorWebBudget.service";

const CAMPAIGN = "90000000000001", OTHER_CAMPAIGN = "90000000000002", OWNER = 27;
const CURRENT = 120_000, TARGET = 150_000;
const PREPARE = { expectedCampaignId: CAMPAIGN, expectedBudgetMinor: CURRENT, targetBudgetMinor: TARGET };
function harness(initialMode: WebBudgetMode = "dry-run") {
  let mode = initialMode, at = Date.parse("2026-06-09T04:00:00.000Z");
  let cap = { revision: 3, campaignCapMinor: 600_000, clientDailyCapMinor: 800_000, locked: false };
  let context: Omit<Awaited<ReturnType<WebBudgetAdapters["readContext"]>>, "observedAt"> = {
    campaignId: CAMPAIGN, reportingDate: "2026-06-09", budgetMinor: CURRENT, spendMinor: 40_000, aggregateSpendMinor: 160_000,
    fingerprint: "a".repeat(64), nativeAutoState: "UNKNOWN",
  };
  const rows = new Map<string, WebBudgetRecord>(), trace: string[] = [];
  const iso = () => new Date(at).toISOString();
  const store: WebBudgetStore = {
    async create(p) { rows.set(p.operationId, { ...p, status: "PREPARED", observedBudgetMinor: null }); },
    async get(owner, id) { const row = rows.get(id); return row?.ownerId === owner ? { ...row } : null; },
    async hasFence() { return [...rows.values()].some(row => row.status === "PROCESSING" || row.status === "OUTCOME_UNKNOWN"); },
    async reserve(owner, id, selectedMode) {
      const row = rows.get(id);
      if (!row || row.ownerId !== owner || row.status !== "PREPARED" || row.mode !== selectedMode || Date.parse(row.expiresAt) <= at
        || [...rows.values()].some(item => item.status === "PROCESSING" || item.status === "OUTCOME_UNKNOWN")) return null;
      rows.set(id, { ...row, status: "PROCESSING" }); trace.push("reserve");
      return { ...row, status: "PROCESSING" };
    },
    async finish(owner, id, value) {
      const row = rows.get(id);
      if (!row || row.ownerId !== owner || row.status !== "PROCESSING") throw new Error("not reserved");
      const done = { ...row, status: value.status, observedBudgetMinor: value.observedBudgetMinor };
      rows.set(id, done); trace.push("finish"); return done;
    },
  };
  const adapters = {
    readPolicy: vi.fn<WebBudgetAdapters["readPolicy"]>(async () => ({ ...cap, readAt: iso() })),
    readContext: vi.fn<WebBudgetAdapters["readContext"]>(async () => ({ ...context, observedAt: iso() })),
    acquireLease: vi.fn<WebBudgetAdapters["acquireLease"]>(async operationId => {
      trace.push("lease"); return { ...cap, locked: true, readAt: iso(), operationId, expiresAt: new Date(at + 60_000).toISOString() };
    }),
    dispatch: vi.fn<WebBudgetAdapters["dispatch"]>(async input => {
      trace.push("dispatch");
      return await input.canSend() ? { outcome: "APPLIED_VERIFIED", observedBudgetMinor: input.targetBudgetMinor } : { outcome: "NOT_SENT" };
    }),
    finishLease: vi.fn<WebBudgetAdapters["finishLease"]>(async () => { trace.push("release"); }),
  };
  const service = createCreatorWebBudgetService({ store, adapters, mode: () => mode, now: () => new Date(at) });
  const confirm = (operationId: string, owner = OWNER, recheck = async () => true) =>
    service.confirm(owner, { operationId, nativeAutoOff: true, noConcurrentChanges: true }, recheck);
  return { rows, trace, store, service, adapters, confirm, setMode: (value: WebBudgetMode) => { mode = value; },
    setCap: (value: Partial<typeof cap>) => { cap = { ...cap, ...value }; },
    setContext: (value: Partial<typeof context>) => { context = { ...context, ...value }; },
    move: (ms: number) => { at += ms; } };
}

describe("Creator web budget workflow", () => {
  it("shows only the cap in read mode, with no prepare or dispatch in the default-disabled mode", async () => {
    const h = harness("disabled");
    expect(await h.service.status(true)).toMatchObject({ mode: "disabled", cap: { revision: 3 }, canPrepare: false });
    await expect(h.service.prepare(OWNER, PREPARE)).rejects.toMatchObject({ code: "BUDGET_MODE_DISABLED" });
    expect(h.adapters.readContext).not.toHaveBeenCalled();
    expect(h.adapters.dispatch).not.toHaveBeenCalled();
  });

  it("stores an expiring owner-bound proposal, simulates, and never acquires a live lease or writes", async () => {
    const h = harness();
    const p = await h.service.prepare(OWNER, PREPARE);
    expect(p).toMatchObject({ mode: "dry-run", campaignId: CAMPAIGN, currentBudgetMinor: CURRENT,
      targetBudgetMinor: TARGET, projectedClientSpendMinor: 270_000, expiresAt: "2026-06-09T04:02:00.000Z" });
    expect(p).not.toHaveProperty("ownerId"); expect(p).not.toHaveProperty("fingerprint");
    await expect(h.confirm(p.operationId, OWNER + 1)).rejects.toMatchObject({ httpStatus: 404 });
    expect(await h.confirm(p.operationId)).toEqual({ operationId: p.operationId, status: "SIMULATED", observedBudgetMinor: null });
    expect(await h.confirm(p.operationId)).toMatchObject({ status: "SIMULATED" });
    expect(h.trace).toEqual(["reserve", "finish"]);
    expect(h.adapters.acquireLease).not.toHaveBeenCalled(); expect(h.adapters.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...PREPARE, targetBudgetMinor: CURRENT }, "BUDGET_NO_CHANGE"],
    [{ ...PREPARE, targetBudgetMinor: 40_000 }, "BUDGET_BELOW_SPEND"],
    [{ ...PREPARE, targetBudgetMinor: 39_999 }, "BUDGET_BELOW_SPEND"],
    [{ ...PREPARE, targetBudgetMinor: 600_001 }, "BUDGET_CAP_EXCEEDED"],
    [{ ...PREPARE, expectedCampaignId: OTHER_CAMPAIGN }, "BUDGET_BASELINE_CHANGED"],
    [{ ...PREPARE, expectedBudgetMinor: CURRENT + 1 }, "BUDGET_BASELINE_CHANGED"],
    [{ ...PREPARE, targetBudgetMinor: TARGET + .1 }, "BUDGET_INPUT_INVALID"],
  ])("refuses invalid/no-op/overspent/above-cap proposals", async (input, code) => {
    const h = harness();
    await expect(h.service.prepare(OWNER, input)).rejects.toMatchObject({ code });
    expect(h.rows.size).toBe(0);
  });

  it("also includes other campaign spend in the client-day cap", async () => {
    const h = harness(); h.setCap({ campaignCapMinor: TARGET, clientDailyCapMinor: 269_999 });
    await expect(h.service.prepare(OWNER, PREPARE)).rejects.toMatchObject({ code: "BUDGET_CAP_EXCEEDED" });
  });

  it.each([
    { budgetMinor: CURRENT + 10 }, { fingerprint: "b".repeat(64) }, { campaignId: OTHER_CAMPAIGN },
    { spendMinor: TARGET }, { aggregateSpendMinor: 800_000 }, { nativeAutoState: "ENABLED" as const },
  ])("rechecks changed provider facts before attempting the live lease", async drift => {
    const h = harness("live"), p = await h.service.prepare(OWNER, PREPARE); h.setContext(drift);
    expect(await h.confirm(p.operationId)).toMatchObject({ status: "NOT_SENT" });
    expect(h.adapters.acquireLease).not.toHaveBeenCalled(); expect(h.adapters.dispatch).not.toHaveBeenCalled();
  });

  it("blocks cap revisions, expired prepares and dry-run-to-live replay", async () => {
    const h = harness(), p = await h.service.prepare(OWNER, PREPARE);
    h.setMode("live"); await expect(h.confirm(p.operationId)).rejects.toMatchObject({ code: "BUDGET_MODE_CHANGED" });
    h.setMode("dry-run"); h.setCap({ revision: 4 }); expect(await h.confirm(p.operationId)).toMatchObject({ status: "NOT_SENT" });
    const next = await h.service.prepare(OWNER, PREPARE); h.move(120_001);
    await expect(h.confirm(next.operationId)).rejects.toMatchObject({ code: "BUDGET_PROPOSAL_EXPIRED" });
    expect(await h.service.operation(OWNER, next.operationId)).toMatchObject({ status: "NOT_SENT" });
    expect(h.adapters.dispatch).not.toHaveBeenCalled();
  });

  it("persists one send fence and accepts only exact readback before releasing the lease", async () => {
    const h = harness("live"), p = await h.service.prepare(OWNER, PREPARE);
    expect(await h.confirm(p.operationId)).toMatchObject({ status: "APPLIED_VERIFIED", observedBudgetMinor: TARGET });
    expect(await h.confirm(p.operationId)).toMatchObject({ status: "APPLIED_VERIFIED" });
    expect(h.trace).toEqual(["reserve", "lease", "dispatch", "finish", "release"]);
    expect(h.adapters.dispatch).toHaveBeenCalledTimes(1);
    expect(h.adapters.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      targetBudgetMinor: TARGET, expectedBudgetMinor: CURRENT, nativeAutoOff: true, noConcurrentChanges: true,
      campaignCapMinor: 600_000, clientDailyCapMinor: 800_000, notAfter: "2026-06-09T04:01:00.000Z", canSend: expect.any(Function),
    }));
  });

  it("retains uncertainty when response or exact readback is unavailable, and forbids a second operation", async () => {
    const h = harness("live"), p = await h.service.prepare(OWNER, PREPARE);
    h.adapters.dispatch.mockResolvedValueOnce({ outcome: "APPLIED_VERIFIED", observedBudgetMinor: TARGET + 1 });
    expect(await h.confirm(p.operationId)).toMatchObject({ status: "OUTCOME_UNKNOWN", observedBudgetMinor: null });
    expect(await h.service.status(true)).toMatchObject({ canPrepare: false });
    expect(h.adapters.finishLease).toHaveBeenCalledWith(p.operationId, "OUTCOME_UNKNOWN");
    await expect(h.service.prepare(OWNER, PREPARE)).rejects.toMatchObject({ code: "BUDGET_WRITE_FENCED" });
    expect(await h.confirm(p.operationId)).toMatchObject({ status: "OUTCOME_UNKNOWN" });
    expect(h.adapters.dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps the lease if terminal persistence fails after sending", async () => {
    const h = harness("live"), p = await h.service.prepare(OWNER, PREPARE);
    vi.spyOn(h.store, "finish").mockRejectedValueOnce(new Error("uncertain durable commit"));
    await expect(h.confirm(p.operationId)).rejects.toThrow("uncertain durable commit");
    expect(await h.service.operation(OWNER, p.operationId)).toMatchObject({ status: "PROCESSING" });
    expect(h.adapters.finishLease).not.toHaveBeenCalled();
    expect(await h.confirm(p.operationId)).toMatchObject({ status: "PROCESSING" });
    expect(h.adapters.dispatch).toHaveBeenCalledTimes(1);
  });

  it("rechecks permission immediately before dispatch and rejects a crossed lease deadline", async () => {
    const h = harness("live"), p = await h.service.prepare(OWNER, PREPARE);
    const auth = vi.fn(async () => true).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await h.confirm(p.operationId, OWNER, auth)).toMatchObject({ status: "NOT_SENT" });
    expect(auth).toHaveBeenCalledTimes(3);
    const next = await h.service.prepare(OWNER, PREPARE);
    h.adapters.acquireLease.mockImplementationOnce(async operationId => ({ ...(await h.adapters.readPolicy()), locked: true,
      operationId, expiresAt: "2026-06-09T04:00:01.000Z" }));
    expect(await h.confirm(next.operationId)).toMatchObject({ status: "NOT_SENT" });
    expect(h.adapters.dispatch).toHaveBeenCalledTimes(1);
  });
});
