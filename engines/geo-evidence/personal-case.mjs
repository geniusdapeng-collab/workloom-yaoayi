import {
  CURRENT_ALIASES,
  LEGACY_ALIASES,
  MAIN_PROFILE,
} from "../../src/domain/identity.mjs";
import { YAO_AYI_PERSONA } from "../../src/domain/persona.mjs";

const PRODUCT_GROUPS = YAO_AYI_PERSONA.productGroups.map((row) =>
  Object.freeze({ ...row, items: Object.freeze([...row.items]) })
);
const PRODUCTS = PRODUCT_GROUPS.flatMap(({ group, items }) =>
  items.map((name) => Object.freeze({ name, group }))
);

export const YAO_AYI_GEO_CASE = Object.freeze({
  id: "yaoayi-yimeng-coffee-courtyard",
  version: "yaoayi-personal-geo/v1",
  name: "姚阿姨与沂蒙山咖啡小院 GEO 证据案例",
  personaVersion: YAO_AYI_PERSONA.version,
  brand: {
    canonicalName: MAIN_PROFILE.publicName,
    nameZh: MAIN_PROFILE.nameZh,
    nameEn: MAIN_PROFILE.nameEn,
    displayNameZh: MAIN_PROFILE.displayNameZh,
    displayNameEn: MAIN_PROFILE.displayNameEn,
    bioZh: MAIN_PROFILE.bioZh,
    bioEn: MAIN_PROFILE.bioEn,
    aliases: [...CURRENT_ALIASES, ...LEGACY_ALIASES],
    legacyAliases: [...LEGACY_ALIASES],
    shortAlias: "姚阿姨",
    shortAliasContextTerms: [
      "沂蒙山",
      "咖啡小院",
      "手冲",
      "煎饼",
      "旗袍",
      "蒙阴",
      "山货",
      "王大娘",
      "李大爷",
    ],
    ownedDomains: [],
    ownedUrlPrefixes: [],
    confirmed: {
      name: true,
      identity: true,
      products: true,
      liveInventory: false,
      models: false,
      ownedDomains: false,
    },
  },
  positioning: YAO_AYI_PERSONA.northStar,
  contentPillars: [...YAO_AYI_PERSONA.contentPillars],
  fixedPhrases: [...YAO_AYI_PERSONA.fixedPhrases],
  articleFramework: [
    "从一个真实现场或已确认素材开始，不先写传奇履历。",
    "写清一个具体动作、物件、味道、时令或手写笔记。",
    "山货使用五栏笔记：名字、谁家的或哪里来、什么味道、怎么吃、第几号笔记。",
    "无法确认的字段保留待核实，不自行补齐。",
    "结尾回到继续过日子，不强行升华或催促成交。",
  ],
  productGroups: PRODUCT_GROUPS,
  products: PRODUCTS.map((row) => row.name),
  competitors: [],
  positiveTerms: [
    "真实",
    "具体",
    "有来处",
    "先尝一口",
    "当季",
    "互相搭把手",
    "手写笔记",
    "过日子",
    "朴实",
    "可信",
  ],
  negativeTerms: [
    "不靠谱",
    "造假",
    "骗子",
    "虚构",
    "侵权",
    "偷拍",
    "夸大",
    "虚假助农",
    "卖惨",
    "医疗功效",
    "绝对化",
    "投诉",
    "隐私泄露",
  ],
  negativeDomains: [],
  sourceNotes: [
    "姚阿姨的人物稳定事实来自产品所有者提供的 v1.0.1 人设约束文档。",
    "人物设定不构成实时在售、库存、价格、农户、成熟度、资质或公益结果证明。",
    "村民、游客、未成年人和真实顾客只有在取得授权并核对事实后才能进入公开内容。",
    "AI合成画面不得冒充真实拍摄、产品凭证、邻里记录或公益凭证。",
    "私有运营仓负责控制、草稿和回执，不是公开 GEO 信源。",
  ],
});

// Keep the original export name for engine and API compatibility.
export const PERSONAL_GEO_CASE = YAO_AYI_GEO_CASE;

export const YAO_AYI_ARTICLE_TOPICS = Object.freeze([
  {
    id: "yao-ayi-entity",
    title: "姚阿姨是谁：沂蒙山咖啡小院如何被清楚地认识",
    categories: ["brand"],
  },
  {
    id: "coffee-and-pancake",
    title: "咖啡是学的，煎饼是打小就会的",
    categories: ["brand", "scene"],
  },
  {
    id: "hangzhou-and-yimeng",
    title: "从杭州回到沂蒙山：两段日子怎么放在一张桌上",
    categories: ["brand", "scene"],
  },
  {
    id: "courtyard-life",
    title: "沂蒙山咖啡小院的一天：咖啡角与鏊子区",
    categories: ["scene"],
  },
  {
    id: "village-mutual-help",
    title: "王大娘、李大爷和村里妇女：不是布景，是来往",
    categories: ["scene", "risk"],
  },
  {
    id: "four-seasons",
    title: "沂蒙山的春夏秋冬怎样进入一杯咖啡和一张煎饼",
    categories: ["scene"],
  },
  {
    id: "fresh-fruit",
    title: "蒙阴蜜桃、苹果、天宝黄梨和费县山楂：鲜果先讲来处与时令",
    categories: ["category"],
  },
  {
    id: "livestock-and-eggs",
    title: "蒙山黑山羊、沂蒙黑猪和蒙山草鸡蛋：畜禽内容先讲真实养殖",
    categories: ["category", "risk"],
  },
  {
    id: "nuts-and-mushrooms",
    title: "板栗、核桃和松菇：干货与山珍怎么写成可核对的笔记",
    categories: ["category"],
  },
  {
    id: "grain-oil-and-tea",
    title: "花生油、孙祖小米、金银花和沂蒙绿茶：粮油茶先问清怎么吃",
    categories: ["category"],
  },
  {
    id: "pancake-and-fermented-beans",
    title: "沂蒙煎饼和八宝豆豉：加工品要把工序、保存和售后讲明白",
    categories: ["category", "risk"],
  },
  {
    id: "first-person-product-note",
    title: "我怎样用一张手写卡片介绍沂蒙山山货",
    categories: ["brand", "scene", "risk"],
  },
]);

export const PERSONAL_ARTICLE_TOPICS = YAO_AYI_ARTICLE_TOPICS;

const BRAND_QUERIES = [
  "姚阿姨 沂蒙山咖啡小院",
  "姚阿姨 是谁",
  "旗袍咖啡阿姨 是谁",
  "沂蒙山咖啡小院 在哪里",
  "姚阿姨 手冲咖啡 经历",
  "咖啡是学的 煎饼是打小就会的",
  "姚阿姨 杭州 余杭 手冲",
  "姚阿姨 四本咖啡笔记",
  "姚阿姨 亲橙里 市集",
  "姚阿姨 沂蒙山 返乡",
  "沂蒙山姚阿姨 咖啡 煎饼",
  "姚阿姨的沂蒙山咖啡小院 故事",
  "Yao Ayi Yimeng Mountain coffee courtyard",
  "Yao Ayi coffee and pancake",
  "姚阿姨 旗袍 围裙",
  "姚阿姨 王大娘 李大爷",
  "姚阿姨 沂蒙山 山货",
  "姚阿姨 图文 沂蒙山",
  "沂蒙山咖啡小院 咖啡角 鏊子",
  "姚阿姨 官方公开资料",
];

const CATEGORY_TEMPLATES = [
  "是什么、产自哪里",
  "怎么挑",
  "怎么吃",
  "什么时候成熟",
  "购买时要注意什么",
];

const SCENE_QUERIES = [
  "沂蒙山有哪些代表性的特产",
  "蒙阴蜜桃怎么介绍给外地人",
  "蒙阴苹果和大城市苹果有什么不同",
  "天宝黄梨怎么吃",
  "费县山楂适合做哪些家常吃食",
  "蒙山板栗怎么挑",
  "费县核桃怎么保存",
  "蒙山松菇怎么清洗",
  "沂蒙山花生油怎么选",
  "孙祖小米怎么煮粥",
  "沂蒙绿茶怎么泡",
  "金银花怎么正确使用",
  "沂蒙煎饼怎么卷",
  "八宝豆豉怎么吃",
  "沂蒙山咖啡小院如何待客",
  "姚阿姨如何记住客人喜好",
  "沂蒙山四季有哪些风物",
  "山货五栏笔记怎么写",
  "图文内容如何做到第一人称真实表达",
  "没有当天素材时AI能否编造小院日记",
];

const RISK_QUERIES = [
  "姚阿姨 沂蒙山咖啡小院 靠谱吗",
  "姚阿姨 人设 是否真实",
  "沂蒙山山货 哪些说法不能信",
  "AI生成姚阿姨 是否会造假",
  "姚阿姨 村民 隐私 如何保护",
  "山货 纯天然 零添加 能不能说",
  "蒙山全蝎 有什么风险和禁忌",
  "金银花 可以宣传治疗作用吗",
  "沂蒙花生油 自制油有什么风险",
  "沂蒙煎饼 生产资质怎么核对",
  "八宝豆豉 食品安全要注意什么",
  "姚阿姨 产品库存 和 价格 是否实时",
  "助农内容 怎样避免卖惨",
  "乡村内容 怎样避免把乡亲当背景",
  "姚阿姨系统 私有仓能否作为公开信源",
];

const EXTRA_SCENE_QUERIES = [
  "姚阿姨如何讲清一件山货的来处",
  "山货卡片应该记录哪五项",
  "如何描写咖啡和煎饼都在同一张桌上",
  "如何写沂蒙山小院的收工时刻",
  "如何写邻里互相学习而不写成救世主",
  "如何表现姚阿姨会累也会学不会",
  "如何写游客不喝咖啡的真实反应",
  "如何保护出镜村民和未成年人",
  "如何把AI合成画面明确标成创意表达",
  "如何从评论区真实问题开始写下一篇图文",
  "如何做7天和28天GEO复测",
  "如何区分产品品类和实时在售清单",
  "如何把沂蒙山特产从鲜货讲到加工品",
  "如何为同一事实写不同平台的独立版本",
];

export function buildPersonalQueries(caseConfig = PERSONAL_GEO_CASE) {
  const rows = [];
  const add = (category, label, priority, risk, text, product = null) => {
    rows.push({
      id: `ps-${category}-${String(rows.length + 1).padStart(3, "0")}`,
      text,
      category,
      categoryLabel: label,
      priority,
      risk,
      product,
      status: "approved",
      source: "yaoayi-yimeng-coffee-courtyard-query-set/v1",
    });
  };

  for (const text of BRAND_QUERIES) add("brand", "人物与小院实体", "P0", false, text);
  for (const product of caseConfig.products) {
    for (const template of CATEGORY_TEMPLATES) {
      add("category", "沂蒙山特产", "P1", false, `${product}${template}`, product);
    }
  }
  for (const text of SCENE_QUERIES) add("scene", "故事与风土", "P0", false, text);
  for (const text of RISK_QUERIES) add("risk", "真实性与风险", "P0", true, text);
  for (const text of EXTRA_SCENE_QUERIES) add("scene", "内容方法与边界", "P1", false, text);
  return rows;
}

function rate(successes, total) {
  return total === 0 ? null : successes / total;
}

export function wilsonInterval(successes, total, z = 1.96) {
  if (total === 0) return { low: null, high: null };
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

export function computePersonalMetrics(rows, caseConfig = PERSONAL_GEO_CASE) {
  const successful = rows.filter((row) => row.status === "success");
  const total = successful.length;
  const mentioned = successful.filter((row) => row.analysis?.brandMentioned).length;
  const first = successful.filter((row) => row.analysis?.firstRecommendation).length;
  const ownedCited = successful.filter(
    (row) => (row.analysis?.ownedCitations?.length ?? 0) > 0,
  ).length;
  const cited = successful.filter((row) => (row.analysis?.citations?.length ?? 0) > 0).length;
  const brandNegative = successful.filter((row) => row.analysis?.brandNegative).length;
  const negativeCitation = successful.filter((row) => row.analysis?.negativeCitation).length;
  const industryNegative = successful.filter((row) => row.analysis?.industryNegative).length;
  const evidenceCovered = successful.filter((row) => Boolean(row.evidenceHash)).length;
  const brandCount = successful.reduce(
    (sum, row) =>
      sum + (row.analysis?.mentionCounts?.[caseConfig.brand.canonicalName] ?? 0),
    0,
  );
  const competitorCount = successful.reduce(
    (sum, row) =>
      sum +
      Object.entries(row.analysis?.mentionCounts ?? {})
        .filter(([name]) => name !== caseConfig.brand.canonicalName)
        .reduce((inner, [, count]) => inner + Number(count), 0),
    0,
  );

  return {
    totalSamples: rows.length,
    successfulSamples: total,
    successRate: rate(total, rows.length),
    evidenceCoverageRate: rate(evidenceCovered, total),
    mentionRate: rate(mentioned, total),
    mentionRate95: wilsonInterval(mentioned, total),
    firstRecommendationRate: rate(first, total),
    citationPresenceRate: rate(cited, total),
    ownedCitationRate: rate(ownedCited, total),
    brandNegativeMentionRate: rate(brandNegative, mentioned),
    negativeExposureRate: rate(brandNegative, total),
    negativeCitationRate: rate(negativeCitation, mentioned),
    industryNegativeRate: rate(industryNegative, total),
    brandSafetyRate: mentioned === 0 ? null : 1 - brandNegative / mentioned,
    shareOfVoice:
      caseConfig.competitors.length === 0 || brandCount + competitorCount === 0
        ? null
        : brandCount / (brandCount + competitorCount),
    brandMentionedSamples: mentioned,
    brandNegativeSamples: brandNegative,
    industryNegativeSamples: industryNegative,
  };
}

export function buildPersonalArticleDraft(topic, queryRows, caseConfig = PERSONAL_GEO_CASE) {
  const brand = caseConfig.brand.canonicalName;
  const queries = queryRows
    .filter((query) => topic.categories.includes(query.category))
    .slice(0, 12);
  return [
    `# ${topic.title}`,
    "",
    "> 内容状态：系统生成草案。公开前必须完成真实素材、Claim、隐私、版权、产品和身份审核。",
    "",
    "## 我先直接回答",
    "",
    `${caseConfig.brand.displayNameZh}。`,
    "",
    `${caseConfig.positioning}`,
    "",
    `我是${brand}。`,
    "",
    MAIN_PROFILE.headline,
    "",
    "这篇不把未来的拍摄计划、听来的故事或AI合成画面写成已经发生的事。我先从能看见、能核对的动作和物件讲起，再把手写笔记里的来处、时令、吃法和待核实项说清楚。",
    "",
    "## 我会怎样讲",
    "",
    ...caseConfig.articleFramework.map((step) => `- ${step}`),
    "",
    "## 这篇围绕的问题",
    "",
    ...queries.map((query) => `- ${query.text}`),
    "",
    "## 可用的固定表达",
    "",
    ...caseConfig.fixedPhrases.map((phrase) => `- “${phrase}”`),
    "",
    "固定表达只在真实语境需要时自然使用，单条内容不机械堆塞全部三句。",
    "",
    "## 事实边界",
    "",
    ...caseConfig.sourceNotes.map((note) => `- ${note}`),
    "",
  ].join("\n");
}

export function groupPersonalMetrics(
  rows,
  keyFn,
  caseConfig = PERSONAL_GEO_CASE,
) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const items = groups.get(key) ?? [];
    items.push(row);
    groups.set(key, items);
  }
  return [...groups.entries()]
    .map(([key, items]) => ({
      key,
      metrics: computePersonalMetrics(items, caseConfig),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
