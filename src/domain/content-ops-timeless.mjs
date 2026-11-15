export const FINAL_CHECKER_VERSION = "pengmanager.independent-checker/v1";
export const TIMELESS_CHECKER_VERSION = "pengmanager.independent-checker/v2";
export const TIMELESS_GATE_VERSION = "pengmanager.timeless-content-gate/v1";
export const TIMELESS_NATIVE_FORMS = Object.freeze(["article", "image_text"]);

export const TIMELESS_CRITERIA = Object.freeze([
  Object.freeze({
    id: "durable_question",
    title: "长期问题",
    question: "十年后，目标读者是否仍会面对同一个经营或决策问题？",
  }),
  Object.freeze({
    id: "stable_mechanism",
    title: "稳定机制",
    question: "结论是否建立在商业机制、组织约束、人性与资源配置上，而不是只依赖当前工具、平台或流量红利？",
  }),
  Object.freeze({
    id: "bounded_context",
    title: "时间边界",
    question: "案例、数字、产品、政策和行业背景是否标明了时间、版本与适用边界，没有被写成永恒事实？",
  }),
  Object.freeze({
    id: "transferable_method",
    title: "可迁移方法",
    question: "读者拿到的是可迁移的判断框架、检查问题或行动方法，而不是一条很快过期的操作技巧？",
  }),
  Object.freeze({
    id: "decay_triggers",
    title: "失效条件",
    question: "文章是否明确写出哪些条件变化会让结论失效，并给出未来复检的触发信号？",
  }),
  Object.freeze({
    id: "future_action",
    title: "未来可用",
    question: "十年后的读者即使工具全变了，是否仍能据此判断、取舍或采取行动？",
  }),
]);

export const TIMELESS_CRITERION_IDS = Object.freeze(TIMELESS_CRITERIA.map(criterion => criterion.id));

export function requiresTimelessGate(pkg = {}) {
  return TIMELESS_NATIVE_FORMS.includes(pkg?.nativeForm);
}

export function checkerVersionForPackage(pkg = {}) {
  return requiresTimelessGate(pkg) ? TIMELESS_CHECKER_VERSION : FINAL_CHECKER_VERSION;
}

export function timelessGateForPackage(pkg = {}) {
  const required = requiresTimelessGate(pkg);
  return {
    schema: TIMELESS_GATE_VERSION,
    required,
    nativeForm: pkg?.nativeForm ?? null,
    criteria: required ? TIMELESS_CRITERIA.map(criterion => ({ ...criterion })) : [],
  };
}

function plainText(value, min, max) {
  return typeof value === "string"
    && value.trim().length >= min
    && value.length <= max
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
}

export function timelessReviewProblem(review) {
  if (!review || typeof review !== "object" || Array.isArray(review)) return "十年内容检验缺少结构化审核记录。";
  const keys = Object.keys(review).sort();
  if (keys.join(",") !== ["criteria", "decayTriggers", "longHorizonVerdict", "schema"].join(",")) return "十年内容检验包含未知或缺失字段。";
  if (review.schema !== TIMELESS_GATE_VERSION) return "十年内容检验版本不符。";
  if (!Array.isArray(review.criteria) || review.criteria.length !== TIMELESS_CRITERIA.length) return "十年内容检验必须覆盖全部六项标准。";
  const seen = new Set();
  for (const criterion of review.criteria) {
    if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) return "十年内容检验标准项无效。";
    const criterionKeys = Object.keys(criterion).sort();
    if (criterionKeys.join(",") !== "evidence,id,status".split(",").sort().join(",")) return "十年内容检验标准项包含未知或缺失字段。";
    if (!TIMELESS_CRITERION_IDS.includes(criterion.id) || seen.has(criterion.id)) return "十年内容检验标准项缺失、重复或不受支持。";
    seen.add(criterion.id);
    if (criterion.status !== "passed") return `十年内容检验未通过：${criterion.id}。`;
    if (!plainText(criterion.evidence, 12, 4000)) return `十年内容检验缺少可复核依据：${criterion.id}。`;
  }
  if (review.criteria.some((criterion, index) => criterion.id !== TIMELESS_CRITERION_IDS[index])) return "十年内容检验未按固定标准顺序完整覆盖。";
  if (TIMELESS_CRITERION_IDS.some(criterionId => !seen.has(criterionId))) return "十年内容检验未按标准顺序完整覆盖。";
  if (!Array.isArray(review.decayTriggers) || review.decayTriggers.length < 1 || review.decayTriggers.length > 8) return "十年内容检验必须给出 1 至 8 个失效触发条件。";
  if (review.decayTriggers.some(trigger => !plainText(trigger, 8, 1000))) return "十年内容检验的失效触发条件缺少具体可核对描述。";
  if (!plainText(review.longHorizonVerdict, 24, 4000)) return "十年内容检验缺少长期可用性结论与依据。";
  return null;
}

export function timelessDimensionStatus(required, review, covered) {
  if (!required) return "not_applicable";
  return covered && timelessReviewProblem(review) === null ? "passed" : "unverified";
}
