import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { JsonStore } from "../src/storage/json-store.mjs";
import { loadSeedState, migrateEditorialState } from "../src/services/bootstrap.mjs";
import { migrateContentOpsState } from "../src/services/content-ops-migration.mjs";
import { migrateContentDirectorState } from "../src/services/content-director-migration.mjs";
import { createEditorialBackup } from "../src/services/editorial-backup.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";
import { EditorialService } from "../src/services/editorial-service.mjs";
import { ContentDirectorService } from "../src/services/content-director-service.mjs";
import { ContentDirectorModel } from "../src/services/content-director-model.mjs";
import { MediaAssets } from "../src/services/media-assets.mjs";
import { hashObject } from "../src/domain/hash.mjs";

const context = () => ({ method: "local", actor: "isolated content director reviewer", idempotencyKey: randomUUID() });
const auditCoverage = { facts: "checked", structure: "checked", expression: "checked", policy: "checked", technical: "checked", visual: "checked" };
const modelReceipt = (id, usage = { total_tokens: 1 }) => ({
  requestedModel: "fixture",
  resolvedModel: "fixture",
  responseId: id,
  requestHash: "a".repeat(64),
  responseHash: "b".repeat(64),
  usage,
});

test("audit schema correction retries once without changing the editorial judgment and preserves both usages", async () => {
  const calls = [];
  const deepSeek = {
    async completeTask(options) {
      calls.push(options);
      if (calls.length === 1) {
        return {
          value: {
            assessment: "事实问题仍需处理",
            findings: [{ severity: "high", dimension: "facts", code: "UNSUPPORTED_FACT", location: "section:0", message: "缺少证据", allowedChanges: ["section:0"] }],
            coverage: { facts: "checked", structure: "checked", expression: "checked", policy: "checked" },
          },
          ...modelReceipt("audit-invalid", { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }),
        };
      }
      return {
        value: {
          assessment: "事实问题仍需处理",
          findings: [{ severity: "major", dimension: "facts", code: "UNSUPPORTED_FACT", location: "section:0", message: "缺少证据", allowedChanges: ["section:0"] }],
          coverage: { facts: "checked", structure: "checked", expression: "checked", policy: "checked" },
        },
        ...modelReceipt("audit-valid", { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }),
      };
    },
  };
  const result = await new ContentDirectorModel({ deepSeek }).auditArticle({ article: { body: "我看这里需要证据。" } });
  assert.equal(calls.length, 2);
  assert.equal(result.value.findings[0].severity, "major");
  assert.equal(result.receipt.attempts[0].type, "audit_schema_rejected");
  assert.equal(result.receipt.attempts[0].responseId, "audit-invalid");
  assert.deepEqual(result.receipt.attempts[0].usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
  assert.match(calls[0].messages[0].content, /severity must be exactly one of/u);
  assert.match(calls[1].messages[3].content, /Correct only the JSON schema/u);
});

test("a second invalid final audit leaves the Job failed and retains both metered attempts", async t => {
  let calls = 0;
  const deepSeek = {
    async completeTask() {
      calls += 1;
      return {
        value: {
          assessment: "invalid",
          findings: [{ severity: "high", dimension: "facts", code: "BAD", location: "section:0", message: "bad", allowedChanges: [] }],
          coverage: auditCoverage,
        },
        ...modelReceipt(`audit-invalid-${calls}`, { prompt_tokens: calls, completion_tokens: 1, total_tokens: calls + 1 }),
      };
    },
  };
  const auditModel = new ContentDirectorModel({ deepSeek });
  const model = new StubModel();
  model.finalAuditArticle = input => auditModel.finalAuditArticle(input);
  const f = await fixture(t, model);
  const job = await f.director.createJob({
    intent: "围绕 Agent 产品进入真实业务写一篇技术文章",
    explicitKind: "article",
    claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 },
  }, context());
  await assert.rejects(
    f.director.processJob(job.id),
    error => {
      assert.equal(error.code, "AUDIT_FINDING_INVALID");
      assert.match(error.message, /severity is invalid/u);
      assert.equal(error.modelReceipt.responseId, "audit-invalid-2");
      assert.equal(error.modelReceipt.attempts[0].responseId, "audit-invalid-1");
      return true;
    },
  );
  assert.equal(calls, 2);
  const failed = await f.director.getJob(job.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.reports.some(report => report.phase === "quality.final"), false);
  assert.equal(failed.result, null);
  const step = failed.steps.find(step => step.kind === "quality.final");
  assert.equal(step.status, "failed");
  assert.equal(step.receipt.usage.total_tokens, 3);
  assert.equal(step.receipt.attempts[0].usage.total_tokens, 2);
});

test("schema correction cannot remove an already valid blocker", async () => {
  const blocker = { severity: "blocker", dimension: "facts", code: "UNSUPPORTED_FACT", location: "section:0", message: "缺少证据。", allowedChanges: [] };
  const malformed = { ...blocker, code: "BAD_DIMENSION", dimension: "业务" };
  let calls = 0;
  const deepSeek = {
    async completeTask() {
      calls += 1;
      return {
        value: {
          assessment: "需要处理阻断项。",
          findings: calls === 1 ? [blocker, malformed] : [{ ...malformed, dimension: "structure" }],
          coverage: auditCoverage,
        },
        ...modelReceipt(`audit-editorial-${calls}`, { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }),
      };
    },
  };
  await assert.rejects(
    new ContentDirectorModel({ deepSeek }).finalAuditArticle({ article: { body: "我看这里需要证据。" } }),
    { code: "AUDIT_FINDING_INVALID", message: /did not preserve the finding count/u },
  );
  assert.equal(calls, 2);
});

test("schema correction stops after one request when provider metering is incomplete", async () => {
  let calls = 0;
  const deepSeek = {
    async completeTask() {
      calls += 1;
      return {
        value: {
          assessment: "缺少证据。",
          findings: [{ severity: "high", dimension: "facts", code: "UNSUPPORTED_FACT", location: "section:0", message: "缺少证据。", allowedChanges: [] }],
          coverage: auditCoverage,
        },
        ...modelReceipt("audit-incomplete-usage", null),
      };
    },
  };
  await assert.rejects(
    new ContentDirectorModel({ deepSeek }).finalAuditArticle({ article: { body: "我看这里需要证据。" } }),
    error => {
      assert.equal(error.code, "MODEL_USAGE_MISSING");
      assert.equal(error.modelReceipt.unknown, true);
      assert.equal(error.modelReceipt.responseId, "audit-incomplete-usage");
      return true;
    },
  );
  assert.equal(calls, 1);
});

class StubModel {
  async generateOutline({ brief }) {
    return {
      value: {
        title: "Agent 产品进入真实业务的工程闭环",
        summary: "从任务、权限、审核、回执和复测解释 Agent 产品如何进入真实业务。",
        sections: [
          { key: "problem", title: "真实业务的问题不是演示", purpose: "说明演示与交付的差别", targetCharacters: 500, claimIds: [] },
          { key: "system", title: "工程闭环的五个要素", purpose: "展开任务、权限、审核、回执和复测", targetCharacters: 700, claimIds: [] },
          { key: "delivery", title: "如何完成可验证交付", purpose: "给出落地路径和限制", targetCharacters: 600, claimIds: [] },
        ],
      },
      receipt: { requestedModel: "fixture", resolvedModel: "fixture", responseId: "outline", requestHash: "a".repeat(64), responseHash: "b".repeat(64), usage: { total_tokens: 1 } },
    };
  }

  async draftSection({ section }) {
    const body = `我看，真正的 Agent 产品必须让${section.title}在真实任务中可验证，而不是只展示一次回答。读者需要看到任务从哪里进入、由谁承担、失败如何恢复，以及最终凭什么确认交付已经发生。${section.key}这一段首先把问题落在可观察行为上。\n\n工程团队需要记录输入、权限、执行、失败和人工介入，再通过独立审核确认内容没有被模型补造成不存在的经历或事实。只有把来源、版本、账号和动作绑定在一起，后续复盘才不会变成对聊天记录的猜测。${section.key}这一段强调证据链而不是语言包装。\n\n这一段还说明落地限制：证据、预算、账号和外部回执必须分别成立，任何缺项都应保留为阻断，而不是用一段更流畅的文字掩盖。系统可以把重复步骤自动化，但不能替用户扩大授权，也不能把未知结果写成成功。${section.key}这一段明确自动化边界。\n\n因此，${section.title}对应的工程能力需要同时覆盖标准流程、异常路径、人工确认和恢复策略。在我看来，它的价值不是让演示更复杂，而是让一次业务任务在多人、多系统和多次重试之后仍然可以被准确解释。${section.key}这一段完成本节的交付闭环。`;
    return {
      value: { title: section.title, body, paragraphs: body.split(/\n\s*\n/), claimIds: [] },
      receipt: { requestedModel: "fixture", resolvedModel: "fixture", responseId: `draft-${section.key}`, requestHash: "c".repeat(64), responseHash: "d".repeat(64), usage: { total_tokens: 1 } },
    };
  }

  async auditArticle() {
    return {
      value: { assessment: "Fixture article is structurally complete.", findings: [], coverage: { facts: "checked", structure: "checked", expression: "checked", policy: "checked", technical: "checked", visual: "checked" } },
      receipt: { requestedModel: "fixture", resolvedModel: "fixture", responseId: "audit", requestHash: "e".repeat(64), responseHash: "f".repeat(64), usage: { total_tokens: 1 } },
    };
  }

  async planVisuals() {
    return {
      value: {
        visuals: [{
          kind: "architecture",
          title: "Agent 产品工程闭环",
          alt: "从任务输入到审核、执行、回执和复测的架构图",
          caption: "图 1：可验证 Agent 产品闭环",
          nodes: [
            { id: "task", label: "任务输入" },
            { id: "gate", label: "权限与围栏" },
            { id: "receipt", label: "回执与复测" },
          ],
          edges: [
            { from: "task", to: "gate", label: "校验" },
            { from: "gate", to: "receipt", label: "执行并留证" },
          ],
        }],
      },
      receipt: { requestedModel: "fixture", resolvedModel: "fixture", responseId: "visual", requestHash: "1".repeat(64), responseHash: "2".repeat(64), usage: { total_tokens: 1 } },
    };
  }
}

async function fixture(t, model = new StubModel()) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "pm-content-director-"));
  const store = new JsonStore({ filePath: join(directory, "state.json") });
  await store.open(() => loadSeedState(resolve(import.meta.dirname, "../data/seed")));
  await migrateEditorialState(store, { publicOrigin: "https://pengmanager.com" });
  const backup = createEditorialBackup({ store });
  await migrateContentOpsState(store, { beforeMigration: () => backup.captureCurrent() });
  await migrateContentDirectorState(store, { beforeMigration: () => backup.captureCurrent() });
  const geoService = new GeoOsService({ store });
  await geoService.approveClaim("C003", { approvedBy: "isolated reviewer", publicLevel: "private" });
  const mediaAssets = new MediaAssets({ store });
  await mediaAssets.initialize();
  const editorial = new EditorialService({ store, geoService, publicOrigin: "https://pengmanager.com" });
  const director = new ContentDirectorService({
    store,
    model,
    editorial,
    mediaAssets,
    artifactRoot: join(directory, "content-director"),
    autoStart: false,
  });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, editorial, mediaAssets, director };
}

test("article Job writes complete sections, independent audit and editable visuals", async t => {
  const finalFinding = {
    severity: "suggestion",
    dimension: "expression",
    code: "OPTIONAL_CAPTION_CONTEXT",
    location: "visualSpecRefs",
    message: "图注可以补充上下文。",
    allowedChanges: [],
  };
  const calls = [];
  const auditModel = new ContentDirectorModel({
    deepSeek: {
      async completeTask(options) {
        calls.push(options);
        return {
          value: { assessment: "完整终审通过。", findings: [finalFinding], coverage: auditCoverage },
          ...modelReceipt("final-valid"),
        };
      },
    },
  });
  const model = new StubModel();
  model.finalAuditArticle = input => auditModel.finalAuditArticle(input);
  const f = await fixture(t, model);
  const job = await f.director.createJob({
    intent: "围绕 Agent 产品如何进入真实业务写一篇技术文章，并配一张架构图",
    claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 },
  }, context());
  assert.equal(job.artifactKind, "article_visual");
  const completed = await f.director.processJob(job.id);
  assert.equal(completed.status, "needs_review");
  assert.equal(completed.result.article.sections.length, 3);
  assert.ok(completed.result.article.body.length > 1000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scene, "quality.final");
  const final = completed.reports.find(report => report.phase === "quality.final");
  assert.deepEqual(final.coverage, auditCoverage);
  assert.equal(final.contentHash, completed.result.contentHash);
  assert.equal(final.findings[0].code, finalFinding.code);
  assert.equal(final.findings[0].severity, finalFinding.severity);
  assert.equal(final.findings.some(row => ["blocker", "major"].includes(row.severity)), false);
  assert.equal(completed.result.visuals.length, 1);
  const svg = await f.director.readArtifact(job.id, `${completed.result.visuals[0].id}.svg`);
  assert.equal(svg.mime, "image/svg+xml");
  assert.match(svg.bytes.toString("utf8"), /Agent 产品工程闭环/);
  const png = await f.director.readArtifact(job.id, `${completed.result.visuals[0].id}.png`);
  assert.equal(png.mime, "image/png");
  assert.equal(png.bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.deepEqual(completed.result.article.visualSpecRefs, completed.result.visuals.map(visual => visual.id));
  assert.equal(completed.persona.id, "yao_ayi_yimeng_coffee_courtyard");
  assert.equal(completed.persona.version, "1.0.1");
  assert.match(completed.persona.documentSha256, /^[a-f0-9]{64}$/);
});

test("preflight ignores only premature missing-visual findings and final audit still blocks them", async t => {
  class PrematureVisualModel extends StubModel {
    constructor() {
      super();
      this.auditInputs = [];
    }
    async auditArticle(input = {}) {
      this.auditInputs.push(structuredClone(input));
      const call = this.auditInputs.length;
      return {
        value: {
          assessment: "视觉尚未生成或视觉缺陷。",
          findings: [{
            severity: "blocker",
            dimension: "technical",
            code: "MISSING_VISUAL_SPEC_AND_DISCLOSURE",
            location: "visualSpecRefs",
            message: "视觉材料缺失。",
            allowedChanges: [],
          }],
          coverage: auditCoverage,
        },
        receipt: {
          requestedModel: "fixture",
          resolvedModel: "fixture",
          responseId: `visual-audit-${call}`,
          requestHash: "3".repeat(64),
          responseHash: "4".repeat(64),
          usage: { total_tokens: 2 },
          attempts: [
            { responseId: `visual-audit-${call}`, responseHash: "4".repeat(64), usage: { total_tokens: 2 } },
            { responseId: `visual-audit-rejected-${call}`, responseHash: "5".repeat(64), usage: { total_tokens: 3 } },
            ...(call === 2 ? [{ type: "provider_failure", usage: null }] : []),
          ],
        },
      };
    }
  }
  const model = new PrematureVisualModel();
  const f = await fixture(t, model);
  const job = await f.director.createJob({
    intent: "围绕 Agent 产品进入真实业务写一篇文章，并配一张架构图",
    artifactKind: "article_visual",
    explicitKind: "article_visual",
    claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 },
  }, context());
  const completed = await f.director.processJob(job.id);
  assert.equal(completed.status, "blocked");
  const preflight = completed.reports.find(report => report.phase === "quality.review");
  const final = completed.reports.find(report => report.phase === "quality.final");
  assert.equal(preflight.usage.total_tokens, 5);
  assert.equal(preflight.usage.responseCount, 2);
  assert.equal(preflight.usage.status, "known_usage");
  assert.equal(preflight.findings.some(finding => finding.code === "MISSING_VISUAL_SPEC_AND_DISCLOSURE"), false);
  assert.equal(final.findings.some(finding => finding.code === "MISSING_VISUAL_SPEC_AND_DISCLOSURE"), true);
  assert.equal(final.usage.status, "unknown_usage");
  assert.ok(completed.steps.some(step => step.kind === "visual.plan" && step.status === "succeeded"));
  assert.ok(completed.steps.some(step => step.kind === "visual.render" && step.status === "succeeded"));
  assert.ok(completed.result.visuals.length > 0);
  assert.ok(completed.result.article.visualSpecRefs.length > 0);
});

test("retry resumes the original Job through a historical missing-visual preflight report", async t => {
  class ResumableVisualModel extends StubModel {
    preflights = 0;
    visualPlans = 0;
    async auditArticle() {
      this.preflights += 1;
      return super.auditArticle();
    }
    async finalAuditArticle() {
      return super.auditArticle();
    }
    async planVisuals(input) {
      this.visualPlans += 1;
      if (this.visualPlans === 1) throw new Error("fixture visual plan interrupted");
      return super.planVisuals(input);
    }
  }
  const model = new ResumableVisualModel();
  const f = await fixture(t, model);
  const job = await f.director.createJob({
    intent: "围绕 Agent 产品进入真实业务写一篇文章，并配一张架构图",
    explicitKind: "article_visual",
    claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 },
  }, context());
  await assert.rejects(f.director.processJob(job.id), /fixture visual plan interrupted/u);
  const failed = await f.director.getJob(job.id);
  assert.equal(failed.status, "failed");
  // Simulate a pre-fix report in the store where this finding was still kept.
  const { result: historical } = await f.store.mutate({ type: "fixture.legacy_audit", actor: "isolated reviewer" }, state => {
    const report = state.contentAuditReports.find(row => row.jobId === job.id && row.phase === "quality.review");
    report.findings.push({
      id: "F-001",
      severity: "major",
      dimension: "disclosure",
      code: "MISSING_VISUAL_SPEC_AND_DISCLOSURE",
      location: "visualSpecRefs",
      message: "Visuals have not been generated yet.",
      allowedChanges: [],
      status: "open",
    });
    const { reportHash, ...body } = report;
    report.reportHash = hashObject(body);
    return structuredClone(report);
  });
  await f.director.startJob(job.id, { ...context(), ifMatch: failed.etag });
  const completed = await f.director.processJob(job.id);
  assert.equal(completed.id, job.id);
  assert.equal(completed.status, "needs_review");
  assert.equal(model.preflights, 1);
  assert.equal(model.visualPlans, 2);
  assert.deepEqual(completed.reports.find(report => report.id === historical.id), historical);
  assert.equal(completed.findings.some(row => row.code === "MISSING_VISUAL_SPEC_AND_DISCLOSURE"), false);
  assert.deepEqual(completed.result.article.visualSpecRefs, completed.result.visuals.map(visual => visual.id));
  assert.equal(completed.result.visuals.length, 1);
});

test("unscoped global-length and Chinese section-title findings receive bounded section repair", async t => {
  for (const [location, code, sectionIndex] of [["全文", "BELOW_TARGET_LENGTH", 1], ["真实业务的问题不是演示", "CHAPTER_LENGTH_LOW", 0]]) {
    await t.test(location, async child => {
      class LocatedRepairModel extends StubModel {
        constructor() {
          super();
          this.auditCalls = 0;
          this.repairs = [];
        }
        async auditArticle() {
          this.auditCalls += 1;
          return {
            value: this.auditCalls === 1
              ? {
                assessment: "需要补充章节内容。",
                findings: [{ severity: "major", dimension: "structure", code, location, message: "内容不足。", allowedChanges: [] }],
                coverage: auditCoverage,
              }
              : { assessment: "修订后通过。", findings: [], coverage: auditCoverage },
            receipt: { requestedModel: "fixture", resolvedModel: "fixture", responseId: `repair-${this.auditCalls}`, requestHash: "5".repeat(64), responseHash: "6".repeat(64), usage: { total_tokens: 1 } },
          };
        }
        async repairSection(input) {
          this.repairs.push(structuredClone(input));
          const body = `${input.currentSection.body}\n\n我再核对一遍这节的证据和边界，把还不够清楚的地方补足。`;
          return {
            value: { title: input.currentSection.title, body, paragraphs: body.split(/\n\s*\n/), claimIds: input.currentSection.claimIds },
            receipt: { requestedModel: "fixture", resolvedModel: "fixture", responseId: `repair-section-${this.repairs.length}`, requestHash: "7".repeat(64), responseHash: "8".repeat(64), usage: { total_tokens: 1 } },
          };
        }
      }
      const model = new LocatedRepairModel();
      const f = await fixture(child, model);
      const job = await f.director.createJob({
        intent: "围绕 Agent 产品进入真实业务写一篇技术文章",
        explicitKind: "article",
        claimIds: ["C003"],
        targetLength: { minCharacters: 1500, maxCharacters: 2500 },
      }, context());
      const completed = await f.director.processJob(job.id);
      assert.equal(model.repairs.length, 1);
      assert.deepEqual(model.repairs[0].findings[0].allowedChanges, [`section:${sectionIndex}`]);
      assert.equal(model.repairs[0].section.title, completed.result.outline.sections[sectionIndex].title);
      assert.ok(completed.steps.some(step => step.kind === "article.repair" && step.status === "succeeded"));
      assert.equal(completed.status, "needs_review");
    });
  }
});

test("preflight keeps real visual defects and the final audit cannot silently clear them", async t => {
  class PreflightBlockingModel extends StubModel {
    async auditArticle() {
      const result = await super.auditArticle();
      result.value.findings = [
        { severity: " MAJOR ", dimension: " TECHNICAL ", code: "VISUAL_UNREADABLE", location: "visualSpecRefs", message: "现有图片的文字不可读。", allowedChanges: [] },
        { severity: "blocker", dimension: "disclosure", code: "MISSING_VISUAL_SPEC_AND_DISCLOSURE", location: "visualSpecRefs", message: "配图尚未生成，但现有图注冒充了真实照片，且没有提供授权。", allowedChanges: [] },
        { severity: "blocker", dimension: "facts", code: "IMAGE_REQUIRED_BUT_MISLEADING", location: "visualSpecRefs", message: "现有图注的产品规格失实。", allowedChanges: [] },
      ];
      return result;
    }
    async finalAuditArticle() {
      return super.auditArticle();
    }
  }
  const f = await fixture(t, new PreflightBlockingModel());
  const job = await f.director.createJob({
    intent: "围绕 Agent 产品进入真实业务写一篇文章，并配一张架构图",
    explicitKind: "article_visual",
    claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 },
  }, context());
  const completed = await f.director.processJob(job.id);
  assert.equal(completed.status, "blocked");
  const preflight = completed.reports.find(report => report.phase === "quality.review");
  const unreadable = preflight.findings.find(finding => finding.code === "VISUAL_UNREADABLE");
  assert.equal(unreadable.severity, "major");
  assert.equal(unreadable.dimension, "technical");
  for (const code of ["VISUAL_UNREADABLE", "MISSING_VISUAL_SPEC_AND_DISCLOSURE", "IMAGE_REQUIRED_BUT_MISLEADING"]) {
    assert.ok(preflight.findings.some(finding => finding.code === code), code);
    assert.ok(completed.findings.some(finding => finding.code === code), code);
  }
  assert.equal(completed.steps.some(step => step.kind === "visual.plan"), false);
});

test("service rejects unsupported severity from a model adapter without saving a report", async t => {
  const model = new StubModel();
  const audit = model.auditArticle.bind(model);
  model.auditArticle = async () => {
    const result = await audit();
    result.value.findings = [
      { severity: "high", dimension: "facts", code: "UNSUPPORTED_FACT", location: "section:0", message: "缺少证据。", allowedChanges: [] },
    ];
    return result;
  };
  const f = await fixture(t, model);
  const job = await f.director.createJob({
    intent: "围绕 Agent 产品进入真实业务写一篇技术文章",
    explicitKind: "article",
    claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 },
  }, context());
  await assert.rejects(f.director.processJob(job.id), { code: "AUDIT_FINDING_INVALID" });
  const failed = await f.director.getJob(job.id);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.reports, []);
});

test("uncited sales, procurement and utilities stay blocked after two bounded repair rounds", async t => {
  const unsupported = ["上月小院销售额达到 ¥12000。", "小院上周进货 ¥2600。", "本月小院水电支出 ¥350。"];
  class UnsupportedBusinessModel extends StubModel {
    repairs = [];
    async draftSection(input) {
      const result = await super.draftSection(input);
      const index = input.outline.sections.findIndex(section => section.key === input.section.key);
      result.value.paragraphs[0] += unsupported[index];
      result.value.body = result.value.paragraphs.join("\n\n");
      return result;
    }
    async repairSection(input) {
      this.repairs.push(input);
      return { value: input.currentSection, receipt: modelReceipt(`business-repair-${this.repairs.length}`) };
    }
  }
  const model = new UnsupportedBusinessModel();
  const f = await fixture(t, model);
  const job = await f.director.createJob({
    intent: "围绕小院真实经营写一篇文章",
    explicitKind: "article",
    claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 },
  }, context());
  const completed = await f.director.processJob(job.id);
  assert.equal(completed.status, "blocked");
  assert.equal(completed.result.complete, false);
  assert.deepEqual([...new Set(model.repairs.map(input => input.round))], [1, 2]);
  const issues = completed.findings.filter(finding => finding.code === "UNCITED_QUANTITATIVE_CLAIM");
  assert.deepEqual(issues.map(finding => [finding.location, finding.severity]), [["section:0", "blocker"], ["section:1", "blocker"], ["section:2", "blocker"]]);
  await assert.rejects(
    f.director.approveJob(job.id, { reviewed: true, contentHash: completed.result.contentHash }, { ...context(), ifMatch: completed.etag }),
    { code: "CONTENT_JOB_NOT_REVIEWABLE" },
  );
});

test("persona violations found in generated copy block the Job before review", async t => {
  class ForbiddenVoiceModel extends StubModel {
    async draftSection(input) {
      const result = await super.draftSection(input);
      result.value.body = `家人们，${result.value.body}`;
      result.value.paragraphs = result.value.body.split(/\n\s*\n/);
      return result;
    }
  }
  const f = await fixture(t, new ForbiddenVoiceModel());
  const job = await f.director.createJob({
    intent: "围绕 Agent 产品进入真实业务写一篇技术文章",
    claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 },
  }, context());
  const completed = await f.director.processJob(job.id);
  assert.equal(completed.status, "blocked");
  assert.ok(completed.findings.some((finding) => finding.code === "PERSONA_FORBIDDEN_TERM"));
  assert.equal(completed.persona.id, "yao_ayi_yimeng_coffee_courtyard");
});

test("article visuals are imported, reviewed and bound to the materialized edition", async t => {
  const f = await fixture(t);
  const job = await f.director.createJob({
    intent: "围绕 Agent 产品如何进入真实业务写一篇文章，并配一张系统架构图",
    claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 },
  }, context());
  const completed = await f.director.processJob(job.id);
  await f.director.approveJob(job.id, { reviewed: true, contentHash: completed.result.contentHash }, { ...context(), ifMatch: completed.etag });
  const materialized = await f.director.materializeEdition(job.id, {
    contentHash: completed.result.contentHash,
    visualRightsConfirmed: true,
    visualRightsNote: "Isolated generated fixture reviewed for exact content, rights and privacy.",
  }, { ...context(), ifMatch: (await f.director.getJob(job.id)).etag });
  assert.equal(materialized.edition.assetRefs.length, 1);
  assert.equal(materialized.edition.assetRefs[0].role, "image");
  assert.equal(f.mediaAssets.getAsset(materialized.edition.assetRefs[0].assetId).status, "reviewed");
  assert.ok(materialized.edition.blocks.some(block => block.type === "image"));
});

test("approved article materializes as an immutable editorial edition", async t => {
  const f = await fixture(t);
  const job = await f.director.createJob({
    intent: "围绕 Agent 产品进入真实业务写一篇技术文章",
    claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 },
  }, context());
  const completed = await f.director.processJob(job.id);
  const approved = await f.director.approveJob(job.id, { reviewed: true, contentHash: completed.result.contentHash, note: "read complete package" }, { ...context(), ifMatch: completed.etag });
  assert.equal(approved.status, "approved");
  const materialized = await f.director.materializeEdition(job.id, { contentHash: completed.result.contentHash }, { ...context(), ifMatch: approved.etag });
  assert.equal(materialized.edition.format, "article");
  assert.equal(materialized.edition.body, completed.result.article.body);
  assert.equal(f.editorial.getEdition(materialized.edition.id).snapshotHash, materialized.edition.snapshotHash);
});
