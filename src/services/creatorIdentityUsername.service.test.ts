import { describe, expect, it, vi } from "vitest";
import { createCreatorIdentityUsernameReader } from "./creatorIdentityUsername.service";

const binding = { advertiserId: "9123456789012345678", tiktokAccountId: "9234567890123456789",
  identityId: "example-bc-identity", identityType: "BC_AUTH_TT", identityAuthorizedBcId: "9345678901234567890" };
const TOKEN = "local-test-credential";
const BASE = { identity_id: binding.identityId, identity_type: binding.identityType,
  identity_authorized_bc_id: binding.identityAuthorizedBcId, username: "real_creator.88", display_name: "Alias must not be used" };

function setup(variant: Record<string, unknown> = {}, { code = 0, outer = {} }: { code?: number; outer?: Record<string, unknown> } = {}) {
  let clock = 1000;
  const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
    expect(`${url.origin}${url.pathname}`).toBe("https://business-api.tiktok.com/open_api/v1.3/identity/info/");
    expect(Object.fromEntries(url.searchParams)).toEqual({ advertiser_id: binding.advertiserId, identity_id: binding.identityId,
      identity_type: binding.identityType, identity_authorized_bc_id: binding.identityAuthorizedBcId });
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("Access-Token")).toBe(TOKEN);
    return Response.json({ code, data: { ...outer, identity_info: { ...BASE, ...variant } } });
  });
  const read = createCreatorIdentityUsernameReader({ loadToken: async () => TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => new Date(clock) }, binding);
  return { read, fetchImpl, setNow: (at: number) => { clock = at; } };
}

describe("Creator TikTok username display metadata", () => {
  it("reads the true handle through the exact identity lookup and coalesces parallel requests", async () => {
    const h = setup();
    expect(await Promise.all([h.read(), h.read()])).toEqual(["real_creator.88", "real_creator.88"]);
    h.setNow(300999);
    expect(await h.read()).toBe("real_creator.88");
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    h.setNow(301000);
    expect(await h.read()).toBe("real_creator.88");
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([{ identity_id: "different-identity" }, { identity_type: "TT_USER" }, { identity_authorized_bc_id: undefined },
    { identity_authorized_bc_id: "9000000000000000001" }, { tiktok_account_id: "9000000000000000001" }, { username: "@not.handle" },
    { username: "space in name" }, { username: undefined }])("returns no handle rather than borrowing a mismatched identity or using an alias: %j", async (patch) => {
    await expect(setup(patch).read()).resolves.toBeNull();
  });

  it("fails closed on provider denials or an advertiser mismatch and briefly caches failure", async () => {
    const denied = setup({}, { code: 40001 });
    expect(await denied.read()).toBeNull();
    expect(await denied.read()).toBeNull();
    expect(denied.fetchImpl).toHaveBeenCalledTimes(1);
    denied.setNow(31000);
    await denied.read();
    expect(denied.fetchImpl).toHaveBeenCalledTimes(2);
    await expect(setup({}, { outer: { advertiser_id: "9000000000000000001" } }).read()).resolves.toBeNull();
  });
});
