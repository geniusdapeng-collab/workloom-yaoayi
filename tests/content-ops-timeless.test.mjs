import test from "node:test";
import assert from "node:assert/strict";
import {
  checkerVersionForPackage,
  requiresTimelessGate,
  timelessGateForPackage,
  timelessReviewProblem,
  TIMELESS_CHECKER_VERSION,
  TIMELESS_CRITERIA,
  TIMELESS_GATE_VERSION,
} from "../src/domain/content-ops-timeless.mjs";
import { buildHumanQualityReview } from "../public/content-ops.js";
import { contentOpsFixture, createOpsJob, finishTextOpsJob, opsContext } from "./content-ops-fixtures.mjs";
import { qualityTextKeys } from "../src/domain/content-ops-quality.mjs";

const validReview = () => ({
  schema: TIMELESS_GATE_VERSION,
  criteria: TIMELESS_CRITERIA.map(criterion => ({
    id: criterion.id,
    status: "passed",
    evidence: `独立核对 ${criterion.id}：该项由长期经营机制、明确边界与可迁移行动支撑。`,
  })),
  decayTriggers: [
    "经营目标、决策责任或组织约束发生根本变化时需要重新检验。",
    "目标读者反复面对的核心经营问题被新的问题替代时需要重新检验。",
  ],
  longHorizonVerdict: "文章围绕长期经营机制、判断框架与行动闭环展开，不依赖某一代 AI 工具；即使平台与工具更替，读者仍能据此识别风险并采取行动。",
});

test("article and image_text require the timeless gate while other native forms remain not applicable", () => {
  for (const nativeForm of ["article", "image_text"]) {
    assert.equal(requiresTimelessGate({ nativeForm }), true);
    assert.equal(checkerVersionForPackage({ nativeForm }), TIMELESS_CHECKER_VERSION);
    assert.equal(timelessGateForPackage({ nativeForm }).criteria.length, 6);
  }
  for (const nativeForm of ["video", "thread", "document", "notebook"]) {
    assert.equal(requiresTimelessGate({ nativeForm }), false);
    assert.equal(timelessGateForPackage({ nativeForm }).criteria.length, 0);
  }
});

test("timeless review requires all six evidence-backed criteria, decay triggers and a long-horizon verdict", () => {
  assert.equal(timelessReviewProblem(validReview()), null);
  assert.match(timelessReviewProblem({ ...validReview(), criteria: TIMELESS_CRITERIA.slice(0, 5).map(criterion => ({ id: criterion.id, status: "passed", evidence: "具体依据不少于十二个字符。" })) }), /全部六项/);
  assert.match(timelessReviewProblem({ ...validReview(), decayTriggers: [] }), /失效触发条件/);
  assert.match(timelessReviewProblem({ ...validReview(), longHorizonVerdict: "会一直有用" }), /长期可用性结论/);
  const failed = validReview();
  failed.criteria[2].evidence = "太短";
  assert.match(timelessReviewProblem(failed), /bounded_context/);
});

test("human article review cannot bypass the timeless fields and sends a versioned structured review", () => {
  const candidate = {
    id: "CAND-timeless",
    packageHash: "a".repeat(64),
    checkContextHash: "b".repeat(64),
    package: {
      nativeForm: "article",
      title: "长期经营",
      summary: "长期判断",
      body: "十年后仍应回答的经营问题。",
      orderedBlocks: [],
      nativeManifest: { settings: { kind: "article" } },
      artifactRefs: [],
      sourceEditionRefs: [],
    },
    requiredCoverage: { textKeys: ["title", "summary", "body", "native:settings"] },
    standards: { timeless: timelessGateForPackage({ nativeForm: "article" }) },
  };
  const base = {
    independent: "on",
    fullText: "on",
    semantic: "on",
    artistic: "on",
    reviewed: "on",
    findings: "[]",
    assessment: "独立完整阅读文章、事实、边界与行动方法。",
  };
  assert.throws(() => buildHumanQualityReview(candidate, base), /十年内容检验/);
  const fields = { ...base };
  for (const criterion of TIMELESS_CRITERIA) {
    fields[`timeless-${criterion.id}`] = "on";
    fields[`timelessEvidence-${criterion.id}`] = `独立核对 ${criterion.title}，确认依据来自长期经营机制而非短期工具。`;
  }
  fields.timelessDecayTriggers = "经营机制、决策责任或读者核心问题发生根本变化时重新检验。";
  fields.timelessVerdict = "文章以经营机制和可迁移判断为核心，工具变化后仍能帮助读者识别风险、做出取舍并采取行动。";
  const input = buildHumanQualityReview(candidate, fields);
  assert.equal(input.checkerVersion, TIMELESS_CHECKER_VERSION);
  assert.equal(input.coverage.timeless, "checked");
  assert.equal(input.timelessReview.schema, TIMELESS_GATE_VERSION);
  assert.deepEqual(input.timelessReview.criteria.map(row => row.id), TIMELESS_CRITERIA.map(row => row.id));
});

test("backend passes a complete article report at checker v2 and revokes it when timeless evidence is missing", async t => {
  const f = await contentOpsFixture(t);
  const { job } = await createOpsJob(f);
  await finishTextOpsJob(f, job.id);
  let candidate = f.ops.getCandidate(f.ops.getJob(job.id, opsContext()).candidates[0].id, opsContext());
  assert.equal(candidate.reports.at(-1).checkerVersion, TIMELESS_CHECKER_VERSION);
  assert.equal(candidate.reports.at(-1).dimensions.timeless, "passed");
  assert.equal(candidate.standards.timeless.required, true);
  const incomplete = await f.ops.submitQualityReport(candidate.id, {
    checkedPackageHash: candidate.packageHash,
    checkContextHash: candidate.checkContextHash,
    reviewed: true,
    coverage: {
      textKeys: qualityTextKeys(candidate.package),
      artifactHashes: [],
      semantic: "checked",
      artistic: "checked",
      timeless: "checked",
    },
    mediaEvidence: [],
    assessment: "隔离负例：完整正文已读，但故意省略十年内容检验的结构化证据。",
  }, opsContext(candidate, "independent timeless negative reviewer"));
  assert.equal(incomplete.status, "needs_input");
  assert.equal(incomplete.dimensions.timeless, "unverified");
  candidate = f.ops.getCandidate(candidate.id, opsContext());
  assert.equal(candidate.status, "needs_input");
  assert.equal(candidate.reviewSnapshotHash, null);
});

test("non-article forms cannot attach a fabricated timeless review", async t => {
  const f = await contentOpsFixture(t, { allDestinations: true });
  const { job } = await createOpsJob(f, { targets: [{ destinationId: f.destinationIds.x, locale: "zh-CN", nativeForm: "thread" }] });
  await finishTextOpsJob(f, job.id);
  const candidate = f.ops.getCandidate(f.ops.getJob(job.id, opsContext()).candidates[0].id, opsContext());
  await assert.rejects(f.ops.submitQualityReport(candidate.id, {
    checkedPackageHash: candidate.packageHash,
    checkContextHash: candidate.checkContextHash,
    reviewed: true,
    coverage: { textKeys: qualityTextKeys(candidate.package), artifactHashes: [], semantic: "checked", artistic: "checked", timeless: "not_applicable" },
    mediaEvidence: [],
    timelessReview: validReview(),
    assessment: "隔离负例：非文章形式不得伪造十年内容检验。",
  }, opsContext(candidate, "independent non-article reviewer")), { code: "QUALITY_REPORT_INVALID" });
});
