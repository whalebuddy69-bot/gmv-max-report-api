import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ initialize: vi.fn(), reader: vi.fn(), load: vi.fn() }));
vi.mock("../routes/creatorRead.route", () => ({ loadCreatorToken: mocks.load }));
vi.mock("../db/dataSource", () => ({ AppDataSource: {} }));
vi.mock("./creatorRead.service", () => ({ createCreatorReader: mocks.reader }));
vi.mock("./creatorBudgetTest.store", () => ({ createCreatorBudgetTestStore: () => ({}) }));
vi.mock("../routes/creatorBudgetTest.route", () => ({ createCreatorBudgetTestRouter: (options: unknown) => options }));
let captured: any;
vi.mock("./creatorBudgetTest.service", () => ({ createCreatorBudgetTestService: (options: unknown) => {
  captured = options;
  return { initialize: mocks.initialize };
} }));
import { createCreatorBudgetTestRuntime } from "./creatorBudgetTest.runtime";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("isolated writer runtime", () => {
  it("requires explicit flag and dedicated key without reusing the read credential", () => {
    vi.stubEnv("CREATOR_BUDGET_TEST_ENABLED", "false");
    vi.stubEnv("CREATOR_BUDGET_TEST_KEY", "w".repeat(43));
    vi.stubEnv("CREATOR_READ_BRIDGE_KEY", "r".repeat(43));
    createCreatorBudgetTestRuntime();
    expect(captured.enabled()).toBe(false);
    vi.stubEnv("CREATOR_BUDGET_TEST_ENABLED", "true");
    expect(captured.enabled()).toBe(true);
    vi.stubEnv("CREATOR_READ_BRIDGE_KEY", "w".repeat(43));
    expect(captured.enabled()).toBe(false);
  });
  it("constructs a new uncached reader for every financial preflight", async () => {
    const reads = vi.fn().mockResolvedValue({ fresh: true });
    mocks.reader.mockImplementation(() => reads);
    createCreatorBudgetTestRuntime();
    await captured.freshSnapshot();
    await captured.freshSnapshot();
    expect(mocks.reader).toHaveBeenCalledTimes(2);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("ledger initialization failure disables only the isolated writer", async () => {
    vi.stubEnv("CREATOR_BUDGET_TEST_ENABLED", "true");
    vi.stubEnv("CREATOR_BUDGET_TEST_KEY", "w".repeat(43));
    vi.stubEnv("CREATOR_READ_BRIDGE_KEY", "r".repeat(43));
    mocks.initialize.mockRejectedValueOnce(new Error("SECRET db error"));
    const runtime = createCreatorBudgetTestRuntime();
    expect(await runtime.initialize()).toBe(false);
    expect(captured.enabled()).toBe(false);
  });
});
