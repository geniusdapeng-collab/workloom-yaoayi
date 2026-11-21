import { ApiError } from "./errors.mjs";
import { hashObject } from "./hash.mjs";

const id = "yaoayi.article.prose";
const version = "1.0.0";
const commonRules = [
  "沿用姚阿姨第一人称。用平常能说出口的话，多写实际动作、物件和做事的次序，每段推进一件事。",
  "只用本任务已确认素材和事实。区分亲历、转述与参考图片。没有依据时缩小叙述范围，不补造日期、物候、味道、对话或人物反应。",
  "用真实细节承担情绪，避免宣传腔、硬套方言、空泛形容、鸡汤和强行升华。有自然的实物、动作或实用结论可承接时就在那里收尾。",
  "事实、合规、授权和冻结人设优先。保留作者确认的意思、引语与事实限定。",
];

const genres = {
  courtyard: [
    "小院记事从一件有依据的物件、动作或来往起笔，围绕同一件小事顺着时间或观察推进。",
    "无需每篇介绍人物履历。若材料只支持一般观察，就按观察写，避免把参考照片、常识或示例写成当天亲历。",
  ],
  handcraft: [
    "手艺文章按有依据的做事顺序推进，写实物、工具、手上动作和能核对的判断依据。",
    "材料支持到哪一步就写到哪一步。操作参数、手艺来历、失败和调整都须有材料依据，缺资料时保留相应限定。",
  ],
  explainer: [
    "说明文章先回答读者的问题，再交代来处、做法、原因或适用条件。各段负责不同问题，专业概念用准确的平常话解释。",
    "有依据的生活例子可以解释问题。山货、产品或技术信息中的条件、来源和未知项写清楚，避免套用小院场景。",
  ],
};

const stages = {
  "content.outline": "在提纲里锁定一条主线和每节有资料支持的任务。首节直接进入物件、动作或读者问题，末节以有依据的细节或结论收束。",
  "content.section": "承接前一节，写足本节的新信息。措辞服务于已冻结的主线与段落任务，保留准确的事实范围。",
  "content.repair": "只在 allowedChanges 允许的段落修正文风和对应的问题。保留其他段落、已核实细节和所有事实限定。",
  "content.audit": "逐项核对文章标题、起笔、各节和结尾。以上规则纳入 coverage.expression，真实检查后标记 checked。具体缺陷写入 findings 的 expression 维度，给出 section:N 或 paragraph:N、实际文字线索和可修范围。虚构经历、对白等应进入 facts 维度。缺证据时检查稿件如何表达未知，不能要求作者补造细节。",
  "quality.final": "复查冻结正文与初审使用同一文风规则，核对标题、各节和结尾。以上规则纳入 coverage.expression，真实检查后标记 checked。残留问题给出具体段落和理由，缺事实依据的问题进入 facts 维度。继续完成当前事实、权利与实际画面的所有终审检查。",
};

const supportedArticles = new Set(["article", "article_visual"]);
const genreSignals = [
  ["explainer", /说明文|科普文?|教程|指南|知识文章|山货笔记|笔记翻翻|技术文章|产品说明|GEO[\s\S]{0,4}(?:说明|解释|问答)/giu],
  ["courtyard", /日记|随笔|散文|小院.{0,4}日常|小院记事|小院故事|山里的客人|邻里记事/gu],
  ["handcraft", /手艺|手工吃食|工序|摊煎饼|手冲咖啡|做煎饼|晒柿饼/gu],
  ["courtyard", /小院|院子|邻里/gu],
];

const refKeys = ["id", "version", "genre", "sha256"];
const registry = Object.freeze({
  // Keep each published version resolvable for jobs that have already frozen it.
  [version]: Object.freeze(Object.fromEntries(Object.entries(genres).map(([genre, rules]) => {
    const sha256 = hashObject({ id, version, genre, commonRules, rules, stages });
    return [genre, Object.freeze({ ref: Object.freeze({ id, version, genre, sha256 }), commonRules, rules, stages })];
  }))),
});

function hasGenreSignal(clauses, signal) {
  const negated = /(?:不要|不用|不写|不做|不采用|不希望|别写|别做|避免|而非|不是)[^，,。！？!?；;\n]{0,12}$/u;
  return clauses.some(clause => [...clause.matchAll(signal)].some(match => !negated.test(clause.slice(0, match.index))));
}

export function resolveArticleProsePolicy({ artifactKind, language, intent } = {}) {
  if (!supportedArticles.has(artifactKind) || language !== "zh-CN") return null;
  const clauses = String(intent ?? "").split(/[，,。！？!?；;\n]|而是|改为/u);
  const genre = genreSignals.find(([, signal]) => hasGenreSignal(clauses, signal))?.[0] ?? "explainer";
  return registry[version][genre].ref;
}

export function isArticleProsePolicyRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== refKeys.length || !refKeys.every(key => Object.hasOwn(value, key))) return false;
  if (value.id !== id || typeof value.version !== "string" || typeof value.genre !== "string") return false;
  const versions = Object.hasOwn(registry, value.version) ? registry[value.version] : null;
  const registered = versions && Object.hasOwn(versions, value.genre) ? versions[value.genre].ref : null;
  return registered !== null && refKeys.every(key => value[key] === registered[key]);
}

export function articleProsePrompt(scene, policy) {
  if (!Object.hasOwn(stages, scene) || policy == null) return "";
  if (!isArticleProsePolicyRef(policy)) {
    throw new ApiError(409, "CONTENT_PROSE_POLICY_INVALID", "文章任务绑定的文风规则版本或摘要无法核验。");
  }
  const published = registry[policy.version][policy.genre];
  return [
    `文章文风规则（服务端冻结）：${policy.id} v${policy.version} / ${policy.genre} / SHA-256 ${policy.sha256}。`,
    ...published.commonRules,
    ...published.rules,
    published.stages[scene],
  ].join("\n");
}
