import { describe, expect, it, vi, beforeEach } from "vitest";

const get = vi.hoisted(() => vi.fn());
vi.mock("axios", () => ({ default: { create: () => ({ get }), isAxiosError: (e: unknown) => Boolean((e as { isAxiosError?: boolean })?.isAxiosError) } }));

import { fetchPublicVideoMetadata, parseOembedUsername, parsePublicPostTime } from "./publicVideoMetadata.service";

const id = "7683142323382832402";
const username = "creator.example";
const response = { embed_product_id: id, author_url: `https://www.tiktok.com/@${username}`, author_name: "ชื่อแสดงผล" };
const now = Date.UTC(2026, 9, 2);
function html(item: unknown) {
  return `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.video-detail": { itemInfo: { itemStruct: item } } } })}</script>`;
}

beforeEach(() => get.mockReset());

describe("verified oEmbed username", () => {
  it("keeps handle separate from the display name", () => {
    expect(parseOembedUsername(response, id)).toBe(username);
  });
  it("supports the documented embed HTML when embed_product_id is absent", () => {
    expect(parseOembedUsername({ author_url: response.author_url, html: `<blockquote data-video-id="${id}">` }, id)).toBe(username);
  });
  it.each(["https://evil.example/@creator", "https://www.tiktok.com.evil.example/@creator", "http://www.tiktok.com/@creator", "https://www.tiktok.com:8443/@creator", "https://user@www.tiktok.com/@creator", "https://www.tiktok.com/@creator/other", "https://www.tiktok.com/@%2Fsecret"])("rejects unsafe author URL %s", (url) => {
    expect(parseOembedUsername({ ...response, author_url: url }, id)).toBeNull();
  });
  it("never accepts a different video, product card, or missing ID", () => {
    expect(parseOembedUsername({ ...response, embed_product_id: "7644814275323727124" }, id)).toBeNull();
    expect(parseOembedUsername(response, "-1")).toBeNull();
    expect(parseOembedUsername({ author_url: response.author_url }, id)).toBeNull();
  });
});

describe("public-page post date", () => {
  it("reads the explicit createTime of the same post in UTC", () => {
    expect(parsePublicPostTime(html({ id, createTime: "1788876180" }), id, now)).toBe("2026-09-08T14:03:00.000Z");
  });
  it("does not borrow a date from another post or a recommended video", () => {
    expect(parsePublicPostTime(html({ id: "7644814275323727124", createTime: "1788876180" }), id, now)).toBeNull();
  });
  it.each([undefined, null, "", 0, "1788876180000", "tomorrow", "9999999999"])("leaves unsupported timestamps unknown: %s", (createTime) => {
    expect(parsePublicPostTime(html({ id, createTime }), id, now)).toBeNull();
  });
  it("does not infer dates from IDs, login/challenge pages, or malformed JSON", () => {
    expect(parsePublicPostTime("Please log in", id, now)).toBeNull();
    expect(parsePublicPostTime('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">bad</script>', id, now)).toBeNull();
  });
});

describe("read-only public metadata calls", () => {
  it("preserves a verified username when post time is unavailable", async () => {
    get.mockResolvedValueOnce({ data: response }).mockResolvedValueOnce({ data: "verification required" });
    expect(await fetchPublicVideoMetadata(id)).toEqual({ username, postedAt: null, error: "public_post_time_unavailable" });
    expect(get.mock.calls[1][0]).toBe(`https://www.tiktok.com/@${username}/video/${id}`);
  });
  it("never requests non-video IDs", async () => {
    expect((await fetchPublicVideoMetadata("-1")).error).toBe("invalid_video_id");
    expect(get).not.toHaveBeenCalled();
  });
  it("does not follow an unverified owner", async () => {
    get.mockResolvedValueOnce({ data: { ...response, embed_product_id: "7644814275323727124" } });
    expect((await fetchPublicVideoMetadata(id)).username).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("records safe status codes without echoing bodies or request secrets", async () => {
    get.mockRejectedValueOnce({ isAxiosError: true, response: { status: 429, data: "private" }, config: { secret: "do-not-log" } });
    expect(await fetchPublicVideoMetadata(id)).toEqual({ username: null, postedAt: null, error: "public_metadata_http_429" });
  });
});
