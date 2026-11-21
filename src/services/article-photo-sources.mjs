import { ApiError } from "../domain/errors.mjs";
import { openImageLicense } from "../domain/article-illustration-policy.mjs";

const WIKIMEDIA_COMMONS = "https://commons.wikimedia.org/w/api.php";
const COMMONS_STORAGE = "upload.wikimedia.org";
const PHOTO_TYPES = new Set(["image/jpeg", "image/png"]);
const MAX_RESULTS = 10;
const WIKIMEDIA_REQUEST_HEADERS = {
  Accept: "application/json", "User-Agent": "YaoAyiArticlePhotos/1.0 (https://github.com/geniusdapeng-collab/workloom-yaoayi)",
};
const PHOTO_PROPERTIES = "LicenseShortName|LicenseUrl|Artist|Credit|ImageDescription";

function plainMetadata(raw, maximum) {
  if (typeof raw !== "string") return "";
  return raw.replace(/<[^>]*>/gu, " ")
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/gu, value => ({
      "&amp;": "&", "&lt;": " ", "&gt;": " ", "&quot;": '"',
      "&apos;": "'", "&nbsp;": " ", "&#39;": "'",
    })[value])
    .replace(/[\\<>\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, maximum);
}

function commonsAssetUrl(raw, host, prefix) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== host || url.username || url.password || url.port || url.hash ||
        !url.pathname.startsWith(prefix)) return null;
    if (url.search && (host !== COMMONS_STORAGE ||
        [...url.searchParams.keys()].some(key => !["utm_source", "utm_campaign", "utm_content"].includes(key)))) return null;
    url.search = "";
    return url.href;
  } catch {
    return null;
  }
  return null;
}

function eligibleCommonsPhoto(page) {
  const source = page?.imageinfo?.[0];
  if (!source || !PHOTO_TYPES.has(source.mime) ||
      !Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height)
      || Math.min(source.width, source.height) < 480 || Math.max(source.width, source.height) < 720) return null;
  const fields = source.extmetadata ?? {};
  const landingUrl = commonsAssetUrl(source.descriptionurl, "commons.wikimedia.org", "/wiki/File:");
  const originalUrl = commonsAssetUrl(source.url, COMMONS_STORAGE, "/wikipedia/commons/");
  const previewUrl = commonsAssetUrl(source.thumburl, COMMONS_STORAGE, "/wikipedia/commons/") ?? originalUrl;
  // Public domain metadata is only screened here. Final registration requires
  // the actual file landing page and its license basis to be reviewed.
  const license = openImageLicense(fields.LicenseUrl?.value)
    ?? (/^public domain$/iu.test(fields.LicenseShortName?.value ?? "")
      ? openImageLicense("https://creativecommons.org/publicdomain/mark/1.0/") : null);
  const credit = plainMetadata(fields.Artist?.value, 240) || plainMetadata(fields.Credit?.value, 240);
  const title = plainMetadata(String(page.title ?? "").replace(/^File:/iu, ""), 240);
  if (!landingUrl || !originalUrl || !license || !credit || !title) return null;
  return {
    provider: "wikimedia_commons",
    reviewRequired: true,
    landingUrl, originalUrl, previewUrl, credit, title, ...license,
    description: plainMetadata(fields.ImageDescription?.value, 500),
    width: source.width, height: source.height, mime: source.mime,
  };
}

export async function discoverArticlePhotos(input, { fetchImpl = fetch } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !["queries", "limit"].includes(key))) {
    throw new ApiError(400, "ARTICLE_PHOTO_QUERY_INVALID", "请输入章节与公开素材检索词。");
  }
  const { queries, limit = 6 } = input;
  if (!Array.isArray(queries) || !queries.length || queries.length > 8 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw new ApiError(400, "ARTICLE_PHOTO_QUERY_INVALID", "每次可查 1–8 个公开检索，单个最多 10 个候选。");
  }
  const keys = new Set();
  const tasks = queries.map(item => {
    const sectionKey = item?.sectionKey;
    const query = typeof item?.query === "string" ? item.query.trim() : "";
    if (!item || typeof item !== "object" || Object.keys(item).length !== 2 ||
        typeof sectionKey !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(sectionKey) || keys.has(sectionKey) ||
        !query || query.length > 160 || /[\u0000-\u001f\u007f]|https?:|file:/iu.test(query)) {
      throw new ApiError(400, "ARTICLE_PHOTO_QUERY_INVALID", "章节键须唯一，检索词须为短语。");
    }
    keys.add(sectionKey);
    return { sectionKey, query };
  });
  const results = [];
  for (const { sectionKey, query } of tasks) {
    const url = new URL(WIKIMEDIA_COMMONS);
    url.search = new URLSearchParams({
      action: "query", format: "json", formatversion: "2", generator: "search",
      gsrnamespace: "6", gsrlimit: String(limit), gsrsearch: `${query} filetype:bitmap`,
      prop: "imageinfo", iiprop: "url|mime|size|extmetadata",
      iiurlwidth: "1200",
      iiextmetadatafilter: PHOTO_PROPERTIES,
    });
    try {
      const response = await fetchImpl(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: WIKIMEDIA_REQUEST_HEADERS,
      });
      if (!response.ok) {
        results.push({ sectionKey, candidates: [], state: "provider_unavailable", httpStatus: response.status });
        continue;
      }
      const payload = await response.json();
      if (payload?.error || (payload?.query?.pages !== undefined && !Array.isArray(payload.query.pages))) {
        results.push({ sectionKey, candidates: [], state: "provider_unavailable" });
        continue;
      }
      const pages = payload?.query?.pages ?? [];
      const ordered = [...pages].sort((a, b) => (a.index ?? limit) - (b.index ?? limit));
      const candidates = ordered.map(eligibleCommonsPhoto).filter(Boolean);
      results.push({ sectionKey, candidates, state: candidates.length ? "review_required" : "no_eligible_candidate" });
    } catch {
      results.push({ sectionKey, candidates: [], state: "provider_unavailable" });
    }
  }
  return { schema: "yaoayi.article-photo-sources/v1", results };
}

function commonsSha1(value) {
  if (typeof value !== "string") return null;
  if (/^[a-f0-9]{40}$/.test(value)) return value;
  if (!/^[a-z0-9]{1,31}$/.test(value)) return null;
  let integer = 0n;
  for (const digit of value) integer = integer * 36n + BigInt(parseInt(digit, 36));
  const hex = integer.toString(16);
  return hex.length <= 40 ? hex.padStart(40, "0") : null;
}

export async function readCommonsPhotoSource(landingUrl, { fetchImpl = fetch } = {}) {
  const selected = commonsAssetUrl(landingUrl, "commons.wikimedia.org", "/wiki/File:");
  if (!selected) throw new ApiError(422, "ARTICLE_PHOTO_SOURCE_INVALID", "请提供 Wikimedia Commons 的独立文件说明页。");
  let title;
  try { title = decodeURIComponent(new URL(selected).pathname.slice("/wiki/".length)); }
  catch { throw new ApiError(422, "ARTICLE_PHOTO_SOURCE_INVALID", "素材文件名无效。"); }
  if (title.length <= "File:".length || title.length > 240 || /[|#<>\u0000-\u001f]/u.test(title)) {
    throw new ApiError(422, "ARTICLE_PHOTO_SOURCE_INVALID", "素材文件名无效。");
  }
  const url = new URL(WIKIMEDIA_COMMONS);
  url.search = new URLSearchParams({
    action: "query", format: "json", formatversion: "2", titles: title,
    prop: "imageinfo", iiprop: "url|mime|size|sha1|extmetadata",
    iiextmetadatafilter: PHOTO_PROPERTIES,
  });
  let payload;
  try {
    const response = await fetchImpl(url, {
      redirect: "error", signal: AbortSignal.timeout(15_000), headers: WIKIMEDIA_REQUEST_HEADERS,
    });
    if (!response.ok) throw new Error("provider did not return official file metadata");
    payload = await response.json();
  } catch {
    throw new ApiError(503, "ARTICLE_PHOTO_SOURCE_UNAVAILABLE", "暂时无法核实 Commons 文件和许可。");
  }
  const page = payload?.query?.pages?.[0];
  const photo = eligibleCommonsPhoto(page);
  const identity = page?.imageinfo?.[0];
  const sha1 = commonsSha1(identity?.sha1);
  if (!photo || !sha1 || !Number.isSafeInteger(identity?.size) || identity.size < 1) {
    throw new ApiError(422, "ARTICLE_PHOTO_SOURCE_UNVERIFIED", "Commons 没有返回可用原图、受支持的许可与准确字节摘要。");
  }
  return { ...photo, sha1, size: identity.size };
}
