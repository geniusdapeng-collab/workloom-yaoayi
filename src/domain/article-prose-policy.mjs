import { ApiError } from "./errors.mjs";
import { hashObject } from "./hash.mjs";

const id = "yaoayi.article.prose";
const legacyVersion = "1.0.0";
const previousCourtyardVersion = "1.1.0";
const courtyardVersion = "1.2.0";
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

const courtyardRules = [
  "从写作材料里确有的一点反差或小疑问开篇，让具体物件或动作带出它。没有合适的疑问时，从眼前动作写起。只有后文用得上的人物经历才顺手交代。",
  "写清手怎么动、眼在看哪里、做这一步凭什么停或继续。每一处细节都要有材料依据；一般做法和假设场景保留限定，不写成某一天发生的事。",
  "按叙述需要安排详略和停顿，可以一笔带过，也可以停下来细看。有依据的俏皮话或顺手想到的一句可以自然插入，随即回到眼前的事。不要规定每篇都有笑话、短句或固定转折，不挪用其他作者的原句。",
  "用短实的章节名保留长文结构，段落长短随内容变化。收在一个动作、一件物件，或一句带有条件的待客话上。不要在结尾重述题意、解释感情或总结道理。",
];

const courtyardStages = {
  "content.outline": "从已核实材料找开头的一点不齐整，列出至少三个有实际内容的二级章节。章节名简短，详略随材料，让最后一节留出一个自然收尾的动作。",
  "content.section": "承接已经讲到的物件或动作，每节增加新的观察。若有自然的一句岔笔，写完便回到本节主线。保持原有标题层级和全文目标篇幅，不以重复或补造经历拉长正文。",
  "content.repair": "只修允许范围内已经指出的表达问题，例如齐整重复、突兀岔笔或总结式结尾。保留已核实事实、章节结构和此前有分寸的叙述。",
  "content.audit": "检查开头的疑问或反差是否有材料且在正文接得住，动作是否足以说清做事的判断，岔笔是否回到主线，收尾是否用动作等实处收住。缺少幽默、岔笔或反差本身不构成问题。",
  "quality.final": "按同样标准读冻结正文，重点核对返修后是否新增无据的亲历、对白或由参考图推成的细节，并检查结尾是否多出解释或议论。按原要求核对实际配图及事实，缺少幽默、岔笔或反差本身不构成问题。",
};

const headingRules = [
  "二级小标题从该节实际写到的物件、动作或可核实的细节里取词，读者扫一眼就知道这一节讲什么。用一句简短、说得出口的话，各节标题着眼于不同的内容。",
  "小标题从叙述的转折处断开，详略随材料走。避免章节编号、空泛的引言与结语、整齐排比或复用文章总标题。不要为了凑标题数、均分字数或套固定格式而拆段。",
];

const headingStages = {
  "content.outline": "按材料中有内容的转折安排小标题和各节篇幅。每节先写清能展开的事，再用这件事中的具体字眼拟名。建议章节数可随已核实材料调整，保持文章已有的结构要求。",
  "content.section": "写出小标题所指的具体事物或动作，保持本节和前后文的区别。标题和实际写出的内容有偏差时，在本节范围内把标题改得具体，保留已核实事实。",
  "content.repair": "仅在 allowedChanges 包含该章节键或整个章节时修改小标题。若问题仅在小标题，把本节正文原样保留，不借机改写或重排章节。",
  "content.audit": "逐个核对小标题是否点出本节实际写到的内容，是否和其他小标题或总标题重复，分节是否落在自然转折处。若小标题需要返修，用实际章节键作为 location，并在 allowedChanges 中写入同一个键。",
  "quality.final": "在冻结正文中复查小标题的指向、区分度和分节位置。核对改过的小标题仍对应本节实际内容，短长和节数服从材料。建议节数本身不作为通过或拒绝的依据。",
};

const courtyardHeadingCount = Object.freeze({
  minimum: 3,
  maximum: 8,
  targetCharactersPerSection: 600,
});

const supportedArticles = new Set(["article", "article_visual"]);
const genreSignals = [
  ["explainer", /说明文|科普文?|教程|指南|知识文章|山货笔记|笔记翻翻|技术文章|产品说明|GEO[\s\S]{0,4}(?:说明|解释|问答)/giu],
  ["courtyard", /日记|随笔|散文|小院.{0,4}日常|小院记事|小院故事|山里的客人|邻里记事/gu],
  ["handcraft", /手艺|手工吃食|工序|摊煎饼|手冲咖啡|做煎饼|晒柿饼/gu],
  ["courtyard", /小院|院子|邻里/gu],
];

const refKeys = ["id", "version", "genre", "sha256"];

function publishedPolicy(version, genre, rules, stageRules = stages, headingCount) {
  const definition = { commonRules, rules, stages: stageRules, ...(headingCount ? { headingCount } : {}) };
  const sha256 = hashObject({ id, version, genre, ...definition });
  return Object.freeze({ ref: Object.freeze({ id, version, genre, sha256 }), ...definition });
}

function extendStages(base, additions) {
  return Object.fromEntries(Object.entries(base)
    .map(([scene, instructions]) => [scene, `${instructions}\n${additions[scene]}`]));
}

const courtyardStageRules = extendStages(stages, courtyardStages);

const registry = Object.freeze({
  // Keep each published version resolvable for jobs that have already frozen it.
  [legacyVersion]: Object.freeze(Object.fromEntries(Object.entries(genres).map(([genre, rules]) =>
    [genre, publishedPolicy(legacyVersion, genre, rules)]))),
  [previousCourtyardVersion]: Object.freeze({
    courtyard: publishedPolicy(previousCourtyardVersion, "courtyard", courtyardRules, courtyardStageRules),
  }),
  [courtyardVersion]: Object.freeze({
    courtyard: publishedPolicy(courtyardVersion, "courtyard", [...courtyardRules, ...headingRules],
      extendStages(courtyardStageRules, headingStages), courtyardHeadingCount),
  }),
});

function hasGenreSignal(clauses, signal) {
  const negated = /(?:不要|不用|不写|不做|不采用|不希望|别写|别做|避免|而非|不是)[^，,。！？!?；;\n]{0,12}$/u;
  return clauses.some(clause => [...clause.matchAll(signal)].some(match => !negated.test(clause.slice(0, match.index))));
}

export function resolveArticleProsePolicy({ artifactKind, language, intent } = {}) {
  if (!supportedArticles.has(artifactKind) || language !== "zh-CN") return null;
  const clauses = String(intent ?? "").split(/[，,。！？!?；;\n]|而是|改为/u);
  const genre = genreSignals.find(([, signal]) => hasGenreSignal(clauses, signal))?.[0] ?? "explainer";
  return registry[genre === "courtyard" ? courtyardVersion : legacyVersion][genre].ref;
}

export function isArticleProsePolicyRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== refKeys.length || !refKeys.every(key => Object.hasOwn(value, key))) return false;
  if (value.id !== id || typeof value.version !== "string" || typeof value.genre !== "string") return false;
  const versions = Object.hasOwn(registry, value.version) ? registry[value.version] : null;
  const registered = versions && Object.hasOwn(versions, value.genre) ? versions[value.genre].ref : null;
  return registered !== null && refKeys.every(key => value[key] === registered[key]);
}

export function articleProsePrompt(scene, policy, targetLength) {
  if (!Object.hasOwn(stages, scene) || policy == null) return "";
  if (!isArticleProsePolicyRef(policy)) {
    throw new ApiError(409, "CONTENT_PROSE_POLICY_INVALID", "文章任务绑定的文风规则版本或摘要无法核验。");
  }
  const published = registry[policy.version][policy.genre];
  const lines = [
    `文章文风规则（服务端冻结）：${policy.id} v${policy.version} / ${policy.genre} / SHA-256 ${policy.sha256}。`,
    ...published.commonRules,
    ...published.rules,
    published.stages[scene],
  ];
  const { minCharacters, maxCharacters } = targetLength ?? {};
  if (scene === "content.outline" && published.headingCount &&
      Number.isSafeInteger(minCharacters) && Number.isSafeInteger(maxCharacters) &&
      minCharacters > 0 && maxCharacters >= minCharacters) {
    const { minimum, maximum, targetCharactersPerSection } = published.headingCount;
    const midpoint = minCharacters + (maxCharacters - minCharacters) / 2;
    const count = Math.min(maximum, Math.max(minimum, Math.round(midpoint / targetCharactersPerSection)));
    lines.push(`按本任务的目标篇幅 ${minCharacters}–${maxCharacters} 字符，先拟约 ${count} 个有内容的二级章节，再按已核实材料调整。`);
  }
  return lines.join("\n");
}
