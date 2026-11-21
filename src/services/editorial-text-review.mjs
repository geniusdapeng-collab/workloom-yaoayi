import { ApiError, PolicyError } from "../domain/errors.mjs";
import { hashObject } from "../domain/hash.mjs";
import { editorialSensitiveFindings, editorialText, publicEditorialClaim } from "../domain/editorial.mjs";

const SCHEMA = "yaoayi.editorial-text-review/v1";
const SHA256 = /^[a-f0-9]{64}$/;
const SEVERITIES = new Set(["blocker", "major", "minor", "suggestion"]);
const DIMENSIONS = new Set(["facts", "structure", "expression", "policy", "technical", "disclosure"]);
const COVERAGE_KEYS = ["facts", "structure", "expression", "policy"];

export function editorialTextReviewInput(state, row, now) {
  const approvedClaimIds = new Set(row.claimIds);
  const claims = state.claims.filter(claim => approvedClaimIds.has(claim.id))
    .map(claim => publicEditorialClaim(claim, { now })).filter(Boolean);
  const article = {
    title: row.title, summary: row.summary, body: row.body, blocks: row.blocks,
    visualReferences: row.assetRefs.map(({ role, alt, caption }) => ({ role, alt, caption })),
  };
  return { article, brief: { locale: row.locale, format: row.format, platformId: row.destinationSnapshot.platformId, claims } };
}

export function editorialTextReviewHash(row, input) {
  return hashObject({ schema: SCHEMA, snapshotHash: row.snapshotHash, input });
}

export function hasEditorialTextReview(row, input) {
  return row.aiPreflight?.schema === SCHEMA && row.aiPreflight.status === "passed"
    && row.aiPreflight.checkContextHash === editorialTextReviewHash(row, input);
}

export async function runEditorialTextReview(model, row, input, now) {
  if (typeof model?.auditArticle !== "function") {
    throw new ApiError(503, "EDITORIAL_AI_REVIEW_UNAVAILABLE", "当前没有可用的 AI 初审服务。");
  }
  if (editorialSensitiveFindings(input).length) {
    throw new PolicyError("EDITORIAL_AI_REVIEW_SENSITIVE", "稿件中包含敏感资料。请移除后再提交 AI 初审。");
  }
  let result;
  try { result = await model.auditArticle(input); }
  catch (cause) {
    const failure = new ApiError(502, "EDITORIAL_AI_REVIEW_FAILED", "AI 初审未完成，原稿状态保持未审。请稍后重试。");
    failure.cause = cause;
    throw failure;
  }
  const { value, receipt } = result ?? {};
  const { inputTokens, outputTokens, totalTokens } = receipt?.usage ?? {};
  if (typeof receipt?.responseId !== "string" || !receipt.responseId.trim()
    || typeof receipt.resolvedModel !== "string" || !receipt.resolvedModel.trim()
    || !SHA256.test(receipt.requestHash ?? "") || !SHA256.test(receipt.responseHash ?? "")
    || receipt.finishReason !== "stop" || receipt.attempts?.some(attempt => attempt.unknown === true)
    || ![inputTokens, outputTokens, totalTokens].every(count => Number.isSafeInteger(count) && count > 0)
    || totalTokens !== inputTokens + outputTokens) {
    throw new ApiError(502, "EDITORIAL_AI_REVIEW_RECEIPT_INVALID", "AI 初审缺少可核对的模型响应及用量回执。");
  }
  if (!Array.isArray(value?.findings) || value.findings.length > 100
    || !COVERAGE_KEYS.every(key => Object.hasOwn(value?.coverage ?? {}, key))) {
    throw new ApiError(502, "EDITORIAL_AI_REVIEW_OUTPUT_INVALID", "AI 初审缺少必要维度的检查结果。");
  }
  const coverage = Object.fromEntries(COVERAGE_KEYS.map(key => [key, value.coverage[key]]));
  const covered = item => item === true || item === "checked" || item === "passed" || item?.status === "passed";
  let findings;
  let assessment;
  try {
    findings = value.findings.map(row => {
      if (!SEVERITIES.has(row?.severity) || !DIMENSIONS.has(row?.dimension)) throw new Error("Invalid review finding");
      return { severity: row.severity, dimension: row.dimension,
        code: editorialText(row.code, "code", 120), location: editorialText(row.location, "location", 240),
        message: editorialText(row.message, "message", 1600) };
    });
    assessment = editorialText(value.assessment, "assessment", 4000);
  } catch {
    throw new ApiError(502, "EDITORIAL_AI_REVIEW_OUTPUT_INVALID", "AI 初审返回了无法读取的问题或评语。");
  }
  const checkedDimensions = Object.fromEntries(Object.entries(coverage).map(([key, value]) => [key, covered(value)]));
  if (editorialSensitiveFindings({ findings, assessment }).length) {
    throw new ApiError(502, "EDITORIAL_AI_REVIEW_OUTPUT_INVALID", "AI 初审结果包含不可保存的敏感信息。");
  }
  return {
    schema: SCHEMA, snapshotHash: row.snapshotHash, checkContextHash: editorialTextReviewHash(row, input),
    status: Object.values(checkedDimensions).every(Boolean)
      && !findings.some(finding => ["blocker", "major"].includes(finding.severity)) ? "passed" : "needs_revision",
    coverage: checkedDimensions, findings, assessment, checkedAt: now.toISOString(),
    receipt: { responseId: receipt.responseId, resolvedModel: receipt.resolvedModel, requestHash: receipt.requestHash,
      responseHash: receipt.responseHash, usage: { inputTokens, outputTokens, totalTokens } },
  };
}
