import axios from "axios";

export interface PublicVideoMetadata {
  username: string | null;
  postedAt: string | null;
  error: string | null;
}

const VIDEO_ID = /^\d{16,22}$/;
const HANDLE = /^[A-Za-z0-9_.]{1,64}$/;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Match by post ID, never by a creator's non-unique display name. */
export function parseOembedUsername(data: unknown, itemId: string): string | null {
  if (!data || typeof data !== "object" || !VIDEO_ID.test(itemId)) return null;
  const value = data as Record<string, unknown>;
  const returnedId = value.embed_product_id ??
    (typeof value.html === "string" ? /data-video-id=["'](\d+)["']/.exec(value.html)?.[1] : null);
  if (returnedId !== itemId || typeof value.author_url !== "string") return null;
  try {
    const url = new URL(value.author_url);
    if (url.protocol !== "https:" || url.hostname !== "www.tiktok.com" || url.port || url.username || url.password) return null;
    const match = /^\/@([^/]+)\/?$/.exec(url.pathname);
    const username = match?.[1];
    return username && HANDLE.test(username) ? username : null;
  } catch {
    return null;
  }
}

/** Public-page evidence, NOT an Ads API field and NOT a timestamp inferred from a video ID. */
export function parsePublicPostTime(html: string, itemId: string, now = Date.now()): string | null {
  const match = /<script\b[^>]*\bid=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) return null;
  try {
    const item = JSON.parse(match[1])?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct;
    if (item?.id !== itemId) return null;
    const raw = item.createTime;
    if ((typeof raw !== "string" && typeof raw !== "number") || !/^\d{9,10}$/.test(String(raw))) return null;
    const milliseconds = Number(raw) * 1000;
    if (milliseconds < Date.UTC(2016, 0, 1) || milliseconds > now + 300_000) return null;
    return new Date(milliseconds).toISOString();
  } catch {
    return null;
  }
}

/** No cookies, login tokens, proxy rotation, challenge solving, or untrusted redirects. */
const publicClient = axios.create({
  timeout: 8_000,
  maxRedirects: 0,
  maxContentLength: MAX_BODY_BYTES,
  maxBodyLength: MAX_BODY_BYTES,
  headers: { Accept: "application/json,text/html" },
});

export async function fetchPublicVideoMetadata(itemId: string): Promise<PublicVideoMetadata> {
  if (!VIDEO_ID.test(itemId)) return { username: null, postedAt: null, error: "invalid_video_id" };
  let username: string | null = null;
  try {
    // TikTok resolves the post ID and returns its canonical author_url. Verify that ID first.
    const response = await publicClient.get("https://www.tiktok.com/oembed", {
      params: { url: `https://www.tiktok.com/@_/video/${itemId}` },
    });
    username = parseOembedUsername(response.data, itemId);
    if (!username) return { username: null, postedAt: null, error: "oembed_metadata_unavailable" };
  } catch (error) {
    return { username: null, postedAt: null, error: publicError(error) };
  }
  try {
    const response = await publicClient.get<string>(`https://www.tiktok.com/@${username}/video/${itemId}`, {
      responseType: "text",
    });
    const postedAt = parsePublicPostTime(response.data, itemId);
    return { username, postedAt, error: postedAt ? null : "public_post_time_unavailable" };
  } catch (error) {
    // Keep a verified username even when the independent post-date lookup is unavailable.
    return { username, postedAt: null, error: publicError(error) };
  }
}

function publicError(error: unknown): string {
  // Never log response bodies, signed media URLs, request configuration, or headers.
  return axios.isAxiosError(error)
    ? `public_metadata_http_${error.response?.status ?? "unavailable"}`
    : "public_metadata_unavailable";
}
