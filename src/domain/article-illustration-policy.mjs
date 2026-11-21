import { ApiError, PolicyError } from "./errors.mjs";
import { requirePublicUrl } from "./public-url.mjs";

export const ARTICLE_MIN_ILLUSTRATIONS = 3;
export const ARTICLE_ILLUSTRATION_SOURCE_TYPES = Object.freeze(["owned", "licensed", "generated"]);
export const EDITORIAL_VISUAL_REQUIREMENT = `每篇文章至少需要 ${ARTICLE_MIN_ILLUSTRATIONS} 张经过场景相关性审阅、实际解码可用且互不重复的正文配图。`;
export const ARTICLE_ILLUSTRATION_HANDOFF = Object.freeze({
  minimum: ARTICLE_MIN_ILLUSTRATIONS,
  executor: "visual-designer",
  workstation: "Compositor",
  composeTool: "visualwrite.compose",
  verifyTool: "visualread.verify",
  mediaPreference: Object.freeze(["authorized_real_photos", "open_licensed_real_photos", "disclosed_generated_illustration"]),
  sourceFinderCli: "node scripts/article-photo-sources.mjs --input-file <private-photo-queries.json>",
  preparationCli: "node scripts/article-visual-preparation.mjs --input-file <private-visual-manifest.json>",
  generatedFallback: "Use the connected workbench image generation tool when authorized and disclose generation in the caption.",
  requires: Object.freeze([
    "冻结正文与配图所在章节",
    "真实成品和来源、版权、隐私核对",
    "实际视觉审阅、替代文字、图注和必要的 AI 披露",
    "绑定原 Job 和正文摘要的配图回执",
  ]),
});

const PLACEHOLDER = /(?:待补(?:图|充)|待替换|暂无(?:图片|配图)|图片占位|占位(?:图片|图|文字|素材)?|示例(?:配图|图片)|默认(?:配图|图片)|文字卡片|文字字卡|\b(?:placeholder|lorem ipsum|dummy (?:image|picture|photo)|sample image|test image|image coming soon)\b)/iu;
const GENERIC = /^(?:插图|插画|图|配图|照片|图片|图像|封面|场景图|image|photo|picture|figure|illustration|cover)\s*[#第\d一二三四五六七八九十]*\s*[张幅.。]?$/iu;

export function isMeaningfulIllustrationText(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 4 && !PLACEHOLDER.test(text)
    && !GENERIC.test(text) && !/(?:https?:\/\/|file:\/\/)/iu.test(text);
}

export function hasGeneratedIllustrationDisclosure(value) {
  return typeof value === "string" && /(?:\bAI[ -]*(?:生成|合成|示意|插画|场景插画|generated|illustrated)|人工智能(?:生成|合成))/iu.test(value);
}

function attributionText(value, field, maximum) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum ||
      /[\u0000-\u001f\u007f<>]/u.test(value) || !isMeaningfulIllustrationText(value)) {
    throw new ApiError(422, "ARTICLE_IMAGE_ATTRIBUTION_INVALID", `图片署名资料 ${field} 无效。`);
  }
  return value.trim();
}

export function openImageLicense(value) {
  if (typeof value !== "string") return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol) || url.hostname !== "creativecommons.org" ||
      url.username || url.password || url.search || url.hash || url.port) return null;
  const match = url.pathname.match(/^\/licenses\/(by|by-sa)\/(1\.0|2\.0|2\.5|3\.0|4\.0)(?:\/(?:deed(?:\.[A-Za-z-]+)?|legalcode(?:\.[A-Za-z-]+)?)?)?$/u);
  if (match) return {
    licenseId: `CC-${match[1].toUpperCase()}-${match[2]}`,
    licenseUrl: `https://creativecommons.org/licenses/${match[1]}/${match[2]}/`,
  };
  const publicDomain = url.pathname.match(/^\/publicdomain\/(zero|mark)\/1\.0(?:\/(?:deed(?:\.[A-Za-z-]+)?|legalcode(?:\.[A-Za-z-]+)?)?)?$/u);
  if (!publicDomain) return null;
  return {
    licenseId: publicDomain[1] === "zero" ? "CC0-1.0" : "PDM-1.0",
    licenseUrl: `https://creativecommons.org/publicdomain/${publicDomain[1]}/1.0/`,
  };
}

export function normalizeOpenImageAttribution(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["landingUrl", "credit", "licenseId", "licenseUrl", "modifications", "title"].includes(key))) {
    throw new ApiError(422, "ARTICLE_IMAGE_ATTRIBUTION_INVALID", "开放授权图片必须提供可核对的逐图署名和许可。");
  }
  const license = openImageLicense(value.licenseUrl);
  if (!license || license.licenseId !== value.licenseId) {
    throw new ApiError(422, "ARTICLE_IMAGE_LICENSE_INVALID", "图片许可与允许修改并公开使用的标准许可不一致。");
  }
  const landingUrl = requirePublicUrl(value.landingUrl, "illustrationAttribution.landingUrl");
  const link = new URL(landingUrl);
  if (link.search || link.hash) {
    throw new ApiError(422, "ARTICLE_IMAGE_ATTRIBUTION_INVALID", "来源请使用素材的独立公开说明页。");
  }
  return {
    landingUrl,
    credit: attributionText(value.credit, "credit", 240),
    ...license,
    modifications: attributionText(value.modifications, "modifications", 240),
    ...(value.title === undefined ? {} : { title: attributionText(value.title, "title", 240) }),
  };
}

export function assertLegacyArticlePipeline(content) {
  if (content?.contentType === "article" && content.snapshotSchema === undefined) {
    throw new PolicyError("ARTICLE_ILLUSTRATIONS_REQUIRED",
      `${EDITORIAL_VISUAL_REQUIREMENT} 请在创作总控或编辑出版中补齐配图后提交审核。`);
  }
}
