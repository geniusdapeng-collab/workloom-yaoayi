import { ApiError } from "./errors.mjs";
import { ARTICLE_ILLUSTRATION_HANDOFF } from "./article-illustration-policy.mjs";
export { EDITORIAL_VISUAL_REQUIREMENT } from "./article-illustration-policy.mjs";
import { hashObject } from "./hash.mjs";
import { requirePublicUrl } from "./public-url.mjs";

export const CONTENT_ARTIFACT_KINDS = Object.freeze([
  "article",
  "article_visual",
  "pure_visual",
  "video_ai",
  "video_edit",
  "video_talking_head",
  "video_mixed",
]);

export const CONTENT_PIPELINES = Object.freeze({
  article: "article.v1",
  article_visual: "article.v1",
  pure_visual: "visual.v1",
  video_ai: "video.ai.v1",
  video_edit: "video.edit.v1",
  video_talking_head: "video.talking_head.v1",
  video_mixed: "video.mixed.v1",
});

const ARTICLE_TERMS = /写|撰写|文章|长文|博客|技术文|观点|方法论|复盘|主题展开|草稿/i;
const VISUAL_TERMS = /配.{0,4}图|插图|图片|架构图|系统图|产品图|流程图|时序图|状态图|状态机图|信息图|信息长图|长图|海报|图卡|图表|柱状图|折线图|节点关系图|关系图|边界图|分层图|科普图|技术图|SVG\s*源?图|可视化/i;
const ILLUSTRATED_ARTICLE_TERMS = /(?:(?:写|撰写|做|制作|生成|准备|产出).{0,6}|(?:给我|来|要)\s*[一两几]篇)图文(?!卡)/u;
const ARTICLE_DIRECTIVE = /(?:写|撰写|完成|起草|生成|创作|产出).{0,12}(?:一篇|文章|长文|技术文|稿件)/u;
const VISUAL_ONLY_TERMS = /只要图片|纯图片|只做图|做成图|只用.{0,12}图|只要.{0,12}图|生成一张|做一张|画一张|出一张|不要文章|不写文章/i;
const VIDEO_TERMS = /视频|短片|影片|成片|镜头|分镜|混剪|剪辑|口播|宣传片|广告片|活动片|形象片|概念片|叙事片|营销片|故事片|知识片|产品片|品牌片|动画|TVC|vlog/i;
const REAL_EDIT_TERMS = /实拍|素材|原片|母片|剪成|剪至|粗剪|精剪|混剪|成片剪辑/i;
const TALKING_HEAD_TERMS = /口播|口述|逐字稿|说话|讲话|访谈|真人出镜|真人母片|词级时间轴|出镜讲解|对着镜头/i;
const AI_VIDEO_TERMS = /AI生成|AI\s*生成|AI\s*镜头|文生视频|图生视频|生成视频|生成.{0,8}(?:视频|短片|影片|动画|片)|数字人|动画|营销片|叙事片|宣传片|AI\s*(?:广告|活动|形象|概念|故事|品牌)片/i;
const MIXED_TERMS = /混合镜表|混合视频|混合片|混合使用.{0,20}AI|(?:AI|生成).{0,24}(?:实拍|真实|录像|门店)|(?:实拍|真实|录像|门店).{0,24}(?:AI|生成)|同一条时间轴|生成式转场/i;
const MARKETING_TERMS = /商品|品牌|种草|带货|开箱|测评|转化|投放|活动片/i;
const EXPLAINER_TERMS = /讲解|科普|教程|解读|盘点评测|知识|解说|演示/i;
const NEGATION = /(?:不要|不需要|不用|不做|不成|不是|并非|别|勿|禁止|不)/;
const VIDEO_SHOT_TYPES = new Set(["ai_generated", "real_footage", "talking_head", "graphic_card", "stock_or_authorized"]);

const ARTICLE_VISUAL_FORMS = [
  ["architecture", /(?:系统)?架构图|系统(?:边界)?图|节点关系图|关系图|分层图|技术图|\barchitecture diagram\b/giu],
  ["flow", /(?:决策)?流程图|时序图|状态(?:机)?图|\bflow\s?chart\b/giu],
  ["chart", /(?:数据)?图表|柱状图|折线图|\b(?:bar chart|line chart|chart)\b/giu],
  ["infographic", /(?:海报式)?信息(?:长)?图|\binfographics?\b/giu],
  ["editorial", /封面|插画|插图|场景图|主视觉|摄影|照片|写实图|实景图|生图|海报(?!式信息图)|\b(?:cover(?: image)?|illustration|editorial image|photograph|photo|hero image)\b/giu],
];
const VISUAL_MODIFIERS = /(?:\s|[的张幅个套页]|[一二两三四五六七八九十几\d]|可编辑|横向|纵向|竖版|横版|高清|真实|五步方法|Mermaid|SVG|a\b|an\b|the\b)*/iu.source;
const VISUAL_DIRECTIVE = new RegExp(
  "(?:[＋+]|配(?:上)?|附(?:上|带)?|加(?:上|入)?|补|提供|出|绘制(?:成)?|画(?:成)?|生成|制作(?:成)?|做(?:成)?|设计|输出|采用|使用|用|需要|要(?:有)?|\\b(?:with|include|add|create|design)\\b)" + VISUAL_MODIFIERS + "$", "iu",
);
const VISUAL_LIST_SEPARATOR = new RegExp("^\\s*(?:和|及|以及|与|、|/|\\band\\b)" + VISUAL_MODIFIERS + "$", "iu");
const VISUAL_MODIFIERS_ONLY = new RegExp("^" + VISUAL_MODIFIERS + "$", "iu");
const DESCRIBED_VISUAL_DIRECTIVE = /(?:配(?:上)?|附(?:上|带)?|加(?:上)?|补|提供|绘制|生成|制作|做|设计|输出)\s*(?:[一二两三四五六七八九十几\d]+[张幅个套])[^。！？!?\n]{0,48}$/u;
const EDITORIAL_VISUAL_DIRECTIVE = /(?:配|附(?:带|上)|补|生成|制作|设计|拍摄|绘制)(?:.{0,14})$/u;
const ARTICLE_TOPIC_SUFFIX = /^\s*(?:的.{0,8}(?:文章|长文|稿件|教程)|相关(?:内容|知识)|(?:怎么|如何|是什么意思))/u;
const QUOTED_VISUAL_TEXT = /《[^》]*》|「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"/gu;
const VISUAL_QUANTITY = /^\s*[一二两三四五六七八九十几\d]+\s*[张幅个套](?=\s*(?:$|[、/]|和|以及|与))/u;
function requestedArticleVisualForms(intent) {
  const requested = new Set();
  const text = String(intent);
  // A verb inside a quoted title does not request an output. A directive outside
  // the quote can still specify a quoted visual name, such as 配一张「架构图」.
  const visualText = text.replace(QUOTED_VISUAL_TEXT, (quoted, index) => {
    const prefix = text.slice(0, index);
    const suffix = text.slice(index + quoted.length);
    const visualDirective = VISUAL_DIRECTIVE.test(prefix) || DESCRIBED_VISUAL_DIRECTIVE.test(prefix);
    return visualDirective && !ARTICLE_TOPIC_SUFFIX.test(suffix) ? quoted.slice(1, -1) : " ";
  });
  for (const clause of visualText.split(/[，,。！？!?；;\n]+|而是|改为/u)) {
    const matches = ARTICLE_VISUAL_FORMS.flatMap(([kind, pattern]) =>
      [...clause.matchAll(pattern)].map(match => ({ kind, match })));
    matches.sort((a, b) => a.match.index - b.match.index || b.match[0].length - a.match[0].length);
    let previousEnd = -1;
    for (const { kind, match } of matches) {
      if (match.index < previousEnd) continue;
      const end = match.index + match[0].length;
      const before = clause.slice(0, match.index);
      const after = clause.slice(end);
      if (ARTICLE_TOPIC_SUFFIX.test(after)) continue;
      const direct = VISUAL_MODIFIERS_ONLY.test(before)
        && (VISUAL_QUANTITY.test(after)
          || /^\s*(?:$|[、/]|和|以及|与|作为配图|用作配图|要有|也要|需要|加|配)/u.test(after)
          || kind === "editorial" && /^\s*(?:是|用|采用|选用|要有|使用)/u.test(after));
      const listed = previousEnd >= 0 && VISUAL_LIST_SEPARATOR.test(clause.slice(previousEnd, match.index));
      const editorialDirection = kind === "editorial" && EDITORIAL_VISUAL_DIRECTIVE.test(before);
      const described = DESCRIBED_VISUAL_DIRECTIVE.test(before);
      if (!(VISUAL_DIRECTIVE.test(before) || listed || direct || described || editorialDirection)
        || !isPositivePrefix(before, "visual") || /\b(?:without|no|do not|don't)\b[^.!?]{0,45}$/iu.test(before)) continue;
      requested.add(kind);
      previousEnd = end;
    }
  }
  return requested;
}

export function articleVisualForm(intent) {
  const requested = requestedArticleVisualForms(intent);
  const kinds = [...requested].filter(kind => kind !== "editorial");
  return {
    mode: kinds.length && !requested.has("editorial") ? "technical" : "editorial",
    kinds,
    ...(requested.has("editorial") || !kinds.length ? { handoff: ARTICLE_ILLUSTRATION_HANDOFF } : {}),
  };
}

const ALLOWED_ATTACHMENT_KINDS = new Set([
  "document",
  "image",
  "video",
  "audio",
  "transcript",
  "data",
  "code",
  "url",
]);

function string(value, name, maximum = 4000) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new ApiError(400, "CONTENT_INTENT_INVALID", `${name} 必须是 1–${maximum} 字符文本。`);
  }
  return value.trim();
}

function boundedInteger(value, name, minimum, maximum, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new ApiError(400, "CONTENT_INTENT_INVALID", `${name} 必须是 ${minimum}–${maximum} 的整数。`);
  }
  return result;
}

function normalizedPlatforms(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 28) throw new ApiError(400, "CONTENT_INTENT_INVALID", "platforms 必须是有界数组。");
  const rows = [...new Set(value.map(item => string(String(item), "platform", 120)))];
  return rows;
}

function normalizedAttachments(value = []) {
  if (!Array.isArray(value) || value.length > 200) throw new ApiError(400, "CONTENT_INTENT_INVALID", "attachments 必须是有界数组。");
  return value.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new ApiError(400, "CONTENT_INTENT_INVALID", `attachments[${index}] 无效。`);
    const kind = string(row.kind, `attachments[${index}].kind`, 40);
    if (!ALLOWED_ATTACHMENT_KINDS.has(kind)) throw new ApiError(400, "CONTENT_INTENT_INVALID", `不支持附件类型 ${kind}。`);
    const id = row.id === undefined ? null : string(String(row.id), `attachments[${index}].id`, 120);
    if (kind === "url") requirePublicUrl(id, `attachments[${index}].id`);
    else if (!id) throw new ApiError(400, "CONTENT_INTENT_INVALID", `attachments[${index}] 必须是先前上传并核对过的真实附件。`);
    return {
      kind,
      id,
      mime: row.mime === undefined ? null : string(String(row.mime), `attachments[${index}].mime`, 160),
      name: row.name === undefined ? null : string(String(row.name), `attachments[${index}].name`, 240),
      speechLikely: row.speechLikely === true,
      durationSec: boundedInteger(row.durationSec, `attachments[${index}].durationSec`, 0, 86_400, null),
      characters: boundedInteger(row.characters, `attachments[${index}].characters`, 0, 100_000, null),
    };
  });
}

function normalizedShotPlan(value, durationSec) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length < 1 || value.length > 80) {
    throw new ApiError(400, "CONTENT_INTENT_INVALID", "混合镜表必须包含 1–80 个镜头。");
  }
  const shots = value.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new ApiError(400, "CONTENT_INTENT_INVALID", `混合镜表第 ${index + 1} 个镜头无效。`);
    }
    const sourceType = string(row.sourceType, `shotPlan[${index}].sourceType`, 40);
    if (!VIDEO_SHOT_TYPES.has(sourceType)) {
      throw new ApiError(400, "CONTENT_INTENT_INVALID", `不支持的镜头来源 ${sourceType}。`);
    }
    const seconds = boundedInteger(row.durationSec, `shotPlan[${index}].durationSec`, 1, 180, null);
    if (!seconds) throw new ApiError(400, "CONTENT_INTENT_INVALID", `混合镜表第 ${index + 1} 个镜头缺少秒数。`);
    const attachmentId = row.attachmentId === undefined ? null : string(String(row.attachmentId), `shotPlan[${index}].attachmentId`, 120);
    const description = row.description === undefined ? "" : string(String(row.description), `shotPlan[${index}].description`, 2000, );
    if (["real_footage", "talking_head", "stock_or_authorized", "graphic_card"].includes(sourceType) && !attachmentId) {
      throw new ApiError(400, "CONTENT_INTENT_INVALID", `镜头来源 ${sourceType} 需要真实附件。`);
    }
    if (sourceType === "ai_generated" && !description) {
      throw new ApiError(400, "CONTENT_INTENT_INVALID", "AI 生成镜头需要明确的画面描述。");
    }
    return {
      index,
      sourceType,
      durationSec: seconds,
      attachmentId,
      description,
      authorizationId: row.authorizationId === undefined ? null : string(String(row.authorizationId), `shotPlan[${index}].authorizationId`, 120),
    };
  });
  if (shots.reduce((total, row) => total + row.durationSec, 0) !== durationSec) {
    throw new ApiError(400, "CONTENT_INTENT_INVALID", "混合镜表各镜秒数之和必须等于目标成片时长。");
  }
  return shots;
}

function normalizeExplicitKind(value) {
  if (value === undefined || value === null || value === "") return null;
  const kind = string(value, "explicitKind", 80);
  if (!CONTENT_ARTIFACT_KINDS.includes(kind)) {
    throw new ApiError(400, "CONTENT_INTENT_INVALID", `未知内容类型 ${kind}。`);
  }
  return kind;
}

function aiVideoSubroute(intent) {
  if (MARKETING_TERMS.test(intent)) return "marketing";
  if (EXPLAINER_TERMS.test(intent) && /口播|解说|讲解|旁白|生成旁白/.test(intent)) return "explainer";
  if (/叙事|故事|剧情|知识|人文|形象片/.test(intent)) return "narrative";
  return "auto";
}

function isPositivePrefix(value, kind) {
  const prefix = value.replace(/“[^”]*”|「[^」]*」|"[^"]*"/gu, "");
  const negation = [...prefix.matchAll(new RegExp(NEGATION.source, "gu"))].at(-1);
  if (!negation || value.length - negation.index - negation[0].length > 24) return true;
  const between = prefix.slice(negation.index + negation[0].length);
  if (kind === "visual") return /文章|长文|博客|视频|短片|影片|镜头|口播/u.test(between);
  if (kind === "article") return /视频|短片|影片|镜头|口播|配图|插图|架构图|信息图|图表|图片|海报/u.test(between);
  if (kind === "video") return /文章|长文|博客|配图|插图|架构图|信息图|图表|图片|海报/u.test(between);
  return false;
}

function hasPositiveSignal(intent, pattern, kind = "generic") {
  const clauses = String(intent).split(/[，,。！？!?；;\n]+/u).map(value => value.trim()).filter(Boolean);
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  const expression = new RegExp(pattern.source, flags);
  return clauses.some(clause => [...clause.matchAll(expression)]
    .some(match => isPositivePrefix(clause.slice(0, match.index), kind)));
}

function routeByRules({ intent, attachments }) {
  const videoAttachments = attachments.filter(row => row.kind === "video");
  const wantsRealEdit = hasPositiveSignal(intent, REAL_EDIT_TERMS, "video");
  const wantsTalkingHead = hasPositiveSignal(intent, TALKING_HEAD_TERMS, "video");
  const wantsAi = hasPositiveSignal(intent, AI_VIDEO_TERMS, "video");
  const wantsMixed = hasPositiveSignal(intent, MIXED_TERMS, "video") || (wantsRealEdit && wantsAi);
  const wantsIllustratedArticle = hasPositiveSignal(intent, ILLUSTRATED_ARTICLE_TERMS, "article");
  const hasArticle = wantsIllustratedArticle || hasPositiveSignal(intent, ARTICLE_TERMS, "article");
  const hasVisual = wantsIllustratedArticle || hasPositiveSignal(intent, VISUAL_TERMS, "visual") || requestedArticleVisualForms(intent).size > 0;
  const hasVideoTerm = hasPositiveSignal(intent, VIDEO_TERMS, "video");
  const explicitVisual = hasPositiveSignal(intent, VISUAL_ONLY_TERMS, "visual");
  const productionAction = /(?:做|制作|生成|输出|导出|剪辑|精剪|混剪|插入|拍|剪成|剪至)[^，,。！？!?；;\n]{0,24}(?:视频|短片|影片|成片|片|镜头|动画)/u.test(intent);
  const videoObjective = wantsMixed || wantsAi || wantsRealEdit || wantsTalkingHead;
  const hasVideo = (videoObjective && (!hasArticle || productionAction)) ||
    (hasVideoTerm && (!hasArticle || productionAction));
  const asksForArticle = wantsIllustratedArticle || hasPositiveSignal(intent, ARTICLE_DIRECTIVE, "article");
  const visualOnly = hasVisual && (!hasArticle || explicitVisual && !asksForArticle) && !hasVideo;

  if (hasVideo) {
    if (wantsMixed || wantsAi && (wantsRealEdit || videoAttachments.length > 0)) {
      return { artifactKind: "video_mixed", confidence: 0.9, rationale: "同时出现 AI 生成和真实视频素材信号。" };
    }
    if ((wantsTalkingHead || videoAttachments.some(row => row.speechLikely)) &&
        (videoAttachments.length <= 1 || videoAttachments.some(row => row.speechLikely))) {
      return { artifactKind: "video_talking_head", confidence: 0.92, rationale: "意图和附件指向单条口播母片精剪。" };
    }
    if (videoAttachments.length > 0 || wantsRealEdit) {
      return { artifactKind: "video_edit", confidence: videoAttachments.length > 1 ? 0.94 : 0.84, rationale: "存在真实视频素材或明确剪辑动作。" };
    }
    if (wantsAi) {
      return { artifactKind: "video_ai", confidence: 0.9, rationale: "明确要求 AI 生成视频。" };
    }
    return {
      artifactKind: "video_ai",
      confidence: 0.62,
      rationale: "出现视频目标，但缺少商品、题材或实拍素材明确信号。",
      missing: ["视频子路线或素材"],
    };
  }
  if (videoAttachments.length) {
    if (videoAttachments.length <= 1 && videoAttachments.some(row => row.speechLikely)) {
      return { artifactKind: "video_talking_head", confidence: 0.9, rationale: "附件明确为单条口播母片。" };
    }
    return {
      artifactKind: "video_edit",
      confidence: videoAttachments.length > 1 ? 0.92 : 0.82,
      rationale: "用户上传了真实视频素材，按实拍剪辑路线处理。",
    };
  }

  if (visualOnly) {
    return { artifactKind: "pure_visual", confidence: 0.92, rationale: "明确只要图片、图表或信息长图，没有文章或视频目标。" };
  }
  if (hasArticle && hasVisual) {
    return { artifactKind: "article_visual", confidence: 0.96, rationale: "明确要求文章和配图。" };
  }
  if (hasArticle) {
    return { artifactKind: "article", confidence: 0.95, rationale: "出现明确文章、写作或长文目标。" };
  }
  if (hasVisual) {
    return { artifactKind: "pure_visual", confidence: 0.82, rationale: "出现图片或图形产物，但没有文章目标。" };
  }
  const hasManuscript = attachments.some(row => row.kind === "document" && (row.characters ?? 0) >= 800);
  if (hasManuscript) {
    return { artifactKind: "article", confidence: 0.78, rationale: "上传了可形成长文的完整文稿材料。" };
  }
  return {
    artifactKind: null,
    confidence: 0.2,
    rationale: "没有识别出文章、图片或视频产物。",
    missing: ["artifactKind"],
  };
}

function normalizeModelDecision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const artifactKind = value.artifactKind;
  if (!CONTENT_ARTIFACT_KINDS.includes(artifactKind)) return null;
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return {
    artifactKind,
    confidence,
    rationale: typeof value.rationale === "string" ? value.rationale.trim().slice(0, 1000) : "模型完成歧义分类。",
  };
}

export function resolveContentIntent({
  intent,
  explicitKind,
  attachments = [],
  platforms = [],
  allowWebResearch = false,
  enableVisuals = "auto",
  targetLength,
  durationSec,
  shotPlan,
  videoRightsConfirmed = false,
  modelDecision,
} = {}) {
  const text = string(intent, "intent", 20_000);
  const explicit = normalizeExplicitKind(explicitKind);
  const files = normalizedAttachments(attachments);
  const targets = normalizedPlatforms(platforms);
  if (!["auto", true, false].includes(enableVisuals)) throw new ApiError(400, "CONTENT_INTENT_INVALID", "enableVisuals 只能是 auto、true 或 false。");
  const rule = explicit
    ? { artifactKind: explicit, confidence: 1, rationale: "用户显式锁定内容类型。" }
    : routeByRules({ intent: text, attachments: files });
  const fallback = !explicit && rule.confidence < 0.7 ? normalizeModelDecision(modelDecision) : null;
  const artifactKind = fallback?.artifactKind ?? rule.artifactKind;
  if (!artifactKind) {
    return {
      schema: "pengmanager.content-intent/v1",
      intent: text,
      artifactKind: null,
      pipeline: null,
      confidence: fallback?.confidence ?? rule.confidence,
      rationale: fallback?.rationale ?? rule.rationale,
      missing: ["artifactKind"],
      clarifyQuestion: "你要产出的是文章、纯图片/信息图、AI视频、实拍剪辑、口播精剪，还是混合视频？",
      attachments: files,
      platforms: targets,
    };
  }
  const missing = [...new Set(rule.missing ?? [])];
  if (["video_edit", "video_talking_head", "video_mixed"].includes(artifactKind) && !files.some(row => row.kind === "video")) {
    missing.push("真实视频素材");
  }
  const article = artifactKind === "article" || artifactKind === "article_visual";
  const hasVisual = article || artifactKind === "pure_visual";
  const visualForm = article ? articleVisualForm(text) : null;
  const normalizedLength = article
    ? {
      minCharacters: boundedInteger(targetLength?.minCharacters, "目标最小字数", 500, 100_000, 2000),
      maxCharacters: boundedInteger(targetLength?.maxCharacters, "目标最大字数", 500, 100_000, 4000),
    }
    : null;
  if (normalizedLength && normalizedLength.minCharacters > normalizedLength.maxCharacters) {
    throw new ApiError(400, "CONTENT_INTENT_INVALID", "目标最小字数不能大于最大字数。");
  }
  const normalizedDuration = artifactKind.startsWith("video_")
    ? boundedInteger(durationSec, "durationSec", 5, 180, null)
    : null;
  if (artifactKind.startsWith("video_") && normalizedDuration === null) missing.push("视频总时长（5–180 秒）");
  const normalizedShots = artifactKind === "video_mixed" && normalizedDuration
    ? normalizedShotPlan(shotPlan, normalizedDuration)
    : null;
  if (artifactKind === "video_mixed" && normalizedDuration && !normalizedShots) missing.push("混合视频逐镜头来源清单");
  const realFootage = artifactKind.startsWith("video_") && !["video_ai"].includes(artifactKind);
  if (realFootage && videoRightsConfirmed !== true) missing.push("真实视频素材的版权、隐私与授权核对");
  const decision = {
    schema: "pengmanager.content-intent/v1",
    intent: text,
    artifactKind,
    routeKind: artifactKind === "article" ? "text_only" : artifactKind === "article_visual" ? "text_visual" :
      artifactKind === "pure_visual" ? "visual_only" : artifactKind,
    sourceMode: files.length ? "user_assets" : allowWebResearch ? "notes_and_research" : "notes",
    pipeline: CONTENT_PIPELINES[artifactKind],
    confidence: fallback?.confidence ?? rule.confidence,
    rationale: fallback?.rationale ?? rule.rationale,
    platforms: targets,
    targetLength: normalizedLength,
    durationSec: normalizedDuration,
    shotPlan: normalizedShots,
    allowWebResearch: allowWebResearch === true,
    videoRightsConfirmed: videoRightsConfirmed === true,
    enableVisuals: article || enableVisuals === true || (enableVisuals === "auto" && hasVisual),
    ...(article ? { visualForm, articleIllustrations: ARTICLE_ILLUSTRATION_HANDOFF } : {}),
    needs: {
      claims: article,
      research: allowWebResearch === true,
      visuals: hasVisual || enableVisuals === true,
      ...(article ? { articleIllustrations: true } : {}),
      realFootage,
      videoRights: realFootage,
      humanReview: true,
      humanApproval: true,
    },
    missing,
    ...(artifactKind === "video_ai" ? { videoSubroute: aiVideoSubroute(text) } : {}),
    attachments: files,
    costClass: artifactKind.startsWith("video_") ? "render" : "model",
    publicationAuthorized: false,
  };
  decision.routeHash = hashObject(decision);
  return decision;
}

export function assertRouteDecision(value) {
  if (!value || value.schema !== "pengmanager.content-intent/v1" || !CONTENT_ARTIFACT_KINDS.includes(value.artifactKind)) {
    throw new ApiError(400, "CONTENT_ROUTE_INVALID", "内容路由结果无效。");
  }
  if (value.pipeline !== CONTENT_PIPELINES[value.artifactKind]) {
    throw new ApiError(400, "CONTENT_ROUTE_INVALID", "内容路由与生产线不一致。");
  }
  return value;
}
