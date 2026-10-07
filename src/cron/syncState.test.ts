import { afterEach, describe, expect, it } from "vitest";
import { claimTargetSync, isTargetRunning, releaseTargetSync, runningTargetKeys } from "./syncState";

afterEach(() => {
  releaseTargetSync("ad-a", "store-a");
  releaseTargetSync("ad-b", "store-b");
});

describe("shared scheduled/manual store reservation", () => {
  it("prevents a second run for the same store until completion", () => {
    expect(claimTargetSync("ad-a", "store-a")).toBe(true);
    expect(claimTargetSync("ad-a", "store-a")).toBe(false);
    expect(isTargetRunning("ad-a", "store-a")).toBe(true);
    expect(runningTargetKeys()).toContain("ad-a:store-a");
    releaseTargetSync("ad-a", "store-a");
    expect(isTargetRunning("ad-a", "store-a")).toBe(false);
    expect(claimTargetSync("ad-a", "store-a")).toBe(true);
  });
  it("does not block a different store and returns a snapshot", () => {
    expect(claimTargetSync("ad-a", "store-a")).toBe(true);
    expect(claimTargetSync("ad-b", "store-b")).toBe(true);
    const snapshot = runningTargetKeys();
    snapshot.length = 0;
    expect(runningTargetKeys()).toHaveLength(2);
  });
});
