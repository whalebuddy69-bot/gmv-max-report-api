import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../db/dataSource", () => ({
  AppDataSource: { query: (...args: unknown[]) => queryMock(...args) },
}));

const postMock = vi.fn();
vi.mock("axios", () => ({
  default: { post: (...args: unknown[]) => postMock(...args) },
}));

vi.mock("../utils/crypto", () => ({
  encryptSecret: (plaintext: string) => `encrypted(${plaintext})`,
}));

import { handleOAuthCallback } from "./webOAuth.service";

function insertCalls() {
  return queryMock.mock.calls.filter(
    (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO oauth_tokens")
  );
}

beforeEach(() => {
  queryMock.mockReset();
  postMock.mockReset();
  process.env.TIKTOK_APP_ID = "test-app-id";
  process.env.TIKTOK_APP_SECRET = "test-app-secret";
  process.env.TIKTOK_OAUTH_REDIRECT_URI = "https://report.example.com/oauth/tiktok/callback";
  process.env.WEB_APP_URL = "https://web.example.com";
});

describe("handleOAuthCallback", () => {
  it("errors when auth_code is missing, no DB access at all, no oauth_tokens insert", async () => {
    const result = await handleOAuthCallback({ state: "some-state" });

    expect(result.status).toBe("error");
    expect(queryMock).not.toHaveBeenCalled();
    expect(insertCalls()).toHaveLength(0);
  });

  it("errors when state is missing, no DB access at all, no oauth_tokens insert", async () => {
    const result = await handleOAuthCallback({ authCode: "auth-code" });

    expect(result.status).toBe("error");
    expect(queryMock).not.toHaveBeenCalled();
    expect(insertCalls()).toHaveLength(0);
  });

  it("errors on an unknown state, no oauth_tokens insert", async () => {
    queryMock.mockResolvedValueOnce([]); // DELETE ... RETURNING found nothing

    const result = await handleOAuthCallback({ authCode: "auth-code", state: "unknown-state" });

    expect(result.status).toBe("error");
    expect(postMock).not.toHaveBeenCalled();
    expect(insertCalls()).toHaveLength(0);
  });

  it("errors on a reused (already-consumed) state, second call sees no row, no insert", async () => {
    const stateRow = {
      state: "s1",
      target_advertiser_id: "adv-1",
      expires_at: new Date(Date.now() + 60_000),
    };
    queryMock.mockResolvedValueOnce([stateRow]); // first call: found and deleted
    postMock.mockResolvedValueOnce({
      data: { code: 0, message: "OK", data: { access_token: "tok", advertiser_ids: ["adv-1"] } },
    });
    queryMock.mockResolvedValueOnce(undefined); // insert during first call

    const first = await handleOAuthCallback({ authCode: "auth-code", state: "s1" });
    expect(first.status).toBe("ok");
    expect(insertCalls()).toHaveLength(1);

    // Second attempt with the same (now-deleted) state, must fail closed, not re-insert.
    queryMock.mockResolvedValueOnce([]);
    const second = await handleOAuthCallback({ authCode: "auth-code", state: "s1" });

    expect(second.status).toBe("error");
    expect(insertCalls()).toHaveLength(1); // still just the one from the first call
  });

  it("errors on an expired state, no oauth_tokens insert", async () => {
    queryMock.mockResolvedValueOnce([
      { state: "s1", target_advertiser_id: "adv-1", expires_at: new Date(Date.now() - 1000) },
    ]);

    const result = await handleOAuthCallback({ authCode: "auth-code", state: "s1" });

    expect(result.status).toBe("error");
    expect(postMock).not.toHaveBeenCalled();
    expect(insertCalls()).toHaveLength(0);
  });

  it("errors when TikTok responds with code !== 0, no oauth_tokens insert", async () => {
    queryMock.mockResolvedValueOnce([
      { state: "s1", target_advertiser_id: "adv-1", expires_at: new Date(Date.now() + 60_000) },
    ]);
    postMock.mockResolvedValueOnce({
      data: { code: 40001, message: "invalid auth_code", data: {} },
    });

    const result = await handleOAuthCallback({ authCode: "bad-code", state: "s1" });

    expect(result.status).toBe("error");
    expect(insertCalls()).toHaveLength(0);
  });

  it("errors when TikTok grants zero advertiser_ids, no oauth_tokens insert", async () => {
    queryMock.mockResolvedValueOnce([
      { state: "s1", target_advertiser_id: "adv-1", expires_at: new Date(Date.now() + 60_000) },
    ]);
    postMock.mockResolvedValueOnce({
      data: { code: 0, message: "OK", data: { access_token: "tok", advertiser_ids: [] } },
    });

    const result = await handleOAuthCallback({ authCode: "auth-code", state: "s1" });

    expect(result.status).toBe("error");
    expect(insertCalls()).toHaveLength(0);
  });

  it("returns ok and inserts a token when the granted advertiser matches the target", async () => {
    queryMock.mockResolvedValueOnce([
      { state: "s1", target_advertiser_id: "adv-target", expires_at: new Date(Date.now() + 60_000) },
    ]);
    postMock.mockResolvedValueOnce({
      data: {
        code: 0,
        message: "OK",
        data: { access_token: "tok", advertiser_ids: ["adv-target", "adv-other"] },
      },
    });
    queryMock.mockResolvedValue(undefined);

    const result = await handleOAuthCallback({ authCode: "auth-code", state: "s1" });

    expect(result.status).toBe("ok");
    expect(result.grantedCount).toBe(2);
    expect(insertCalls()).toHaveLength(2);
  });

  it("returns mismatch, but still inserts the token, when the granted advertiser differs", async () => {
    queryMock.mockResolvedValueOnce([
      { state: "s1", target_advertiser_id: "adv-target", expires_at: new Date(Date.now() + 60_000) },
    ]);
    postMock.mockResolvedValueOnce({
      data: { code: 0, message: "OK", data: { access_token: "tok", advertiser_ids: ["adv-other"] } },
    });
    queryMock.mockResolvedValueOnce(undefined); // insert

    const result = await handleOAuthCallback({ authCode: "auth-code", state: "s1" });

    expect(result.status).toBe("mismatch");
    expect(result.grantedCount).toBe(1);
    const inserts = insertCalls();
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toContain("adv-other");
  });
});
