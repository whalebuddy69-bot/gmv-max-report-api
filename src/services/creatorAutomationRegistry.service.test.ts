import { describe, expect, it, vi } from "vitest";
import { CREATOR_BINDING } from "./creatorRead.service";
import { createAutomationReadRegistry, parseExtraAutomationClients, parseVerifiedAutomationBindings, PPAN_AUTOMATION_CREATOR,
  validAutomationClientId } from "./creatorAutomationRegistry.service";
import type { AutomationCreatorReadAdapter } from "./creatorAutomationRegistry.service";

const EXTRA = { clientId: "creator-fixture", displayName: "ครีเอเตอร์ ทดสอบ", advertiserId: "8000000000000000001", tiktokAccountId: "7000000000000000001" };
const OTHER = { clientId: "second-fixture", displayName: "Creator Two", advertiserId: "8000000000000000002", tiktokAccountId: "7000000000000000002" };
const BINDING = { advertiserId: EXTRA.advertiserId, tiktokAccountId: EXTRA.tiktokAccountId, identityId: "fixture-identity",
  identityType: "BC_AUTH_TT", identityAuthorizedBcId: "9000000000000000001" };
const ADAPTER: AutomationCreatorReadAdapter = { clientId: EXTRA.clientId, binding: BINDING,
  readSnapshot: vi.fn(async () => null), readPerformance: vi.fn(async () => null) };
const ppan = { readSnapshot: vi.fn(async () => null), readPerformance: vi.fn(async () => null) };

describe("server-only Creator Automation registry", () => {
  it("accepts strict bounded metadata without interpreting IDs as Javascript numbers", () => {
    expect(parseExtraAutomationClients(JSON.stringify([EXTRA, OTHER]))).toEqual([EXTRA, OTHER]);
    expect(validAutomationClientId(EXTRA.clientId)).toBe(true);
    for (const bad of ["2abc", "A-b", "a", "p/..", "p%2f", "a".repeat(41), "_fixture", " has-spaces "]) {
      expect(validAutomationClientId(bad)).toBe(false);
    }
  });

  it("drops all extras if metadata has ambiguous identities, unsafe values, or non-exact fields", () => {
    for (const invalid of [undefined, "", "not JSON", " ".repeat(4097), JSON.stringify(EXTRA), JSON.stringify([null]),
      JSON.stringify(Array(9).fill(EXTRA)),
      ...[
        { ...EXTRA, clientId: PPAN_AUTOMATION_CREATOR.clientId },
        { ...EXTRA, advertiserId: CREATOR_BINDING.advertiserId },
        { ...EXTRA, tiktokAccountId: CREATOR_BINDING.tiktokAccountId },
        { ...EXTRA, advertiserId: Number(EXTRA.advertiserId) },
        { ...EXTRA, tiktokAccountId: "0000001" },
        { ...EXTRA, displayName: "Data\u202E leak" },
        { ...EXTRA, displayName: "‹ unsafe ›" },
        { ...EXTRA, displayName: " leading space" },
        { ...EXTRA, scope: "write" },
      ].map(value => JSON.stringify([OTHER, value])),
      JSON.stringify([EXTRA, { ...OTHER, clientId: EXTRA.clientId }]),
      JSON.stringify([EXTRA, { ...OTHER, advertiserId: EXTRA.advertiserId }]),
      JSON.stringify([EXTRA, { ...OTHER, tiktokAccountId: EXTRA.tiktokAccountId }]),
    ]) expect(parseExtraAutomationClients(invalid)).toEqual([]);
    expect(createAutomationReadRegistry({ extraConfig: "garbled", ppan })[0]).toMatchObject({
      creator: PPAN_AUTOMATION_CREATOR, adapter: { binding: CREATOR_BINDING },
    });
  });

  it("never grants read access solely from metadata and only attaches a unique verified exact binding", () => {
    const extraConfig = JSON.stringify([EXTRA]);
    expect(createAutomationReadRegistry({ extraConfig, ppan })[1]).toEqual({ creator: EXTRA, adapter: null, accessReason: "needs-authorization" });
    expect(createAutomationReadRegistry({ extraConfig, ppan, pendingReason: () => "identity-unverified" })[1]).toMatchObject({
      adapter: null, accessReason: "identity-unverified",
    });
    expect(createAutomationReadRegistry({ extraConfig, ppan, verifiedExtras: [ADAPTER] })[1].adapter).toBe(ADAPTER);
    for (const verifiedExtras of [[ADAPTER, ADAPTER],
      [{ ...ADAPTER, binding: { ...BINDING, tiktokAccountId: OTHER.tiktokAccountId } }],
      [{ ...ADAPTER, binding: { ...BINDING, advertiserId: OTHER.advertiserId } }],
      [{ ...ADAPTER, binding: { ...BINDING, identityAuthorizedBcId: "invalid" } }],
      [{ ...ADAPTER, binding: { ...BINDING, identityType: "CUSTOMIZED_USER" } }],
    ]) expect(createAutomationReadRegistry({ extraConfig, ppan, verifiedExtras })[1]).toMatchObject({ adapter: null, accessReason: "identity-unverified" });
    expect(ADAPTER.readSnapshot).not.toHaveBeenCalled();
    expect(ADAPTER.readPerformance).not.toHaveBeenCalled();
  });

  it("accepts proof only from exact separate server config and refuses mismatches, extras, and duplicate identity pins", () => {
    const verified = { clientId: EXTRA.clientId, ...BINDING };
    expect(parseVerifiedAutomationBindings(JSON.stringify([verified]), [EXTRA, OTHER])).toEqual([verified]);
    expect(parseVerifiedAutomationBindings(JSON.stringify([verified]), [])).toEqual([]);
    for (const invalid of [undefined, "", "not JSON", JSON.stringify(verified), JSON.stringify([null]), JSON.stringify([verified, verified]),
      JSON.stringify([verified, { ...verified, clientId: OTHER.clientId, advertiserId: OTHER.advertiserId, tiktokAccountId: OTHER.tiktokAccountId }]),
      ...[
        { ...verified, clientId: "unconfigured" },
        { ...verified, advertiserId: OTHER.advertiserId },
        { ...verified, tiktokAccountId: OTHER.tiktokAccountId },
        { ...verified, identityId: CREATOR_BINDING.identityId },
        { ...verified, identityType: "CUSTOMIZED_USER" },
        { ...verified, identityAuthorizedBcId: 9000001 },
        { ...verified, tiktokAccountIdVerified: true },
      ].map(value => JSON.stringify([value])),
    ]) expect(parseVerifiedAutomationBindings(invalid, [EXTRA, OTHER])).toEqual([]);
  });
});
