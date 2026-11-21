import test from "node:test";
import assert from "node:assert/strict";
import crypto, { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import sharp from "sharp";
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
import { resolveArticleProsePolicy } from "../src/domain/article-prose-policy.mjs";
import { hashObject } from "../src/domain/hash.mjs";
import { scanSensitiveText } from "../src/domain/policy.mjs";
import { bindFixtureArticleIllustrations, fixtureArticleIllustrationVerifier, processIllustratedArticle } from "./article-illustration-fixture.mjs";

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
    processIllustratedArticle(f.director, job.id, context()),
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

async function fixture(t, model = new StubModel(), articleIllustrationVerifier = fixtureArticleIllustrationVerifier) {
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
    articleIllustrationVerifier,
    artifactRoot: join(directory, "content-director"),
    autoStart: false,
  });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, editorial, mediaAssets, director };
}

test("new Chinese article Jobs and batch topics freeze the server-selected prose policy", async t => {
  const f = await fixture(t);
  const article = { intent: "写一篇姚阿姨的小院日记", explicitKind: "article", claimIds: ["C003"] };
  const ctx = context();
  const forgedPolicy = { id: "external", version: "3.0.0", genre: "handcraft", sha256: "0".repeat(64) };
  const job = await f.director.createJob({ ...article, stylePolicy: forgedPolicy }, ctx);
  assert.deepEqual(job.stylePolicy, resolveArticleProsePolicy({ artifactKind: "article", language: "zh-CN", intent: article.intent }));
  assert.equal(job.stylePolicy.genre, "courtyard");
  assert.equal(Object.hasOwn(job.input, "stylePolicy"), false);
  assert.deepEqual((await f.director.createJob({ ...article, stylePolicy: forgedPolicy }, ctx)).stylePolicy, job.stylePolicy);
  const patched = await f.director.patchBrief(job.id, { goal: "突出有依据的日常动作" }, { ...context(), ifMatch: job.etag });
  assert.deepEqual(patched.stylePolicy, job.stylePolicy);
  await assert.rejects(f.director.patchBrief(job.id, { language: "en-US" }, { ...context(), ifMatch: patched.etag }),
    { code: "CONTENT_STYLE_LANGUAGE_CHANGED" });

  const batch = await f.director.createBatch({
    name: "中文体裁与语言边界",
    shared: { claimIds: ["C003"], language: "zh-CN", stylePolicy: forgedPolicy },
    topics: [
      { intent: "写手工吃食和摊煎饼工序的文章并配图", explicitKind: "article_visual" },
      { intent: "写山货笔记", explicitKind: "article" },
      { ...article, language: "en-US" },
      { intent: "制作架构图", explicitKind: "pure_visual" },
    ],
  }, context());
  assert.deepEqual(batch.jobs.map(row => row.stylePolicy?.genre), ["handcraft", "explainer", undefined, undefined]);
  const english = batch.jobs[2];
  const chineseDraft = await f.director.patchBrief(english.id, { language: "zh-CN" }, { ...context(), ifMatch: english.etag });
  assert.deepEqual(chineseDraft.stylePolicy, job.stylePolicy);
});

test("the same style binding reaches scoped repair and is required on the exact frozen approval report", async t => {
  class ProseModel extends StubModel {
    calls = [];
    async generateOutline(input) {
      this.calls.push(["outline", input]);
      return super.generateOutline(input);
    }
    async draftSection(input) {
      this.calls.push(["section", input]);
      return super.draftSection(input);
    }
    async auditArticle(input) {
      const first = !this.calls.some(([phase]) => phase === "preflight");
      this.calls.push(["preflight", input]);
      const result = await super.auditArticle(input);
      if (first) {
        result.value.findings = [{
          severity: "major", dimension: "expression", code: "PROSE_OPENER_TOO_ABSTRACT",
          location: "section:0 paragraph:1", message: "首段未从材料支持的动作或读者问题入手。",
          allowedChanges: ["paragraph:1"],
        }];
      }
      return result;
    }
    async repairSection(input) {
      this.calls.push(["repair", input]);
      const paragraphs = [...input.currentSection.paragraphs];
      paragraphs[0] = "我先从怎样判断一次任务已经做完说起。" + paragraphs[0];
      return {
        value: { title: input.currentSection.title, paragraphs, body: paragraphs.join("\n\n"), claimIds: input.currentSection.claimIds },
        receipt: modelReceipt("prose-repair"),
      };
    }
    async finalAuditArticle(input) {
      this.calls.push(["final", input]);
      return super.auditArticle(input);
    }
  }

  const model = new ProseModel();
  const f = await fixture(t, model);
  const job = await f.director.createJob({
    intent: "写一篇技术文章，说明怎么核验一次真实业务交付",
    explicitKind: "article",
    claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 },
  }, context());
  const waiting = await f.director.processJob(job.id);
  const frozenText = waiting.articleDraft.article.body;
  assert.equal(waiting.status, "needs_input");
  await bindFixtureArticleIllustrations(f.director, waiting, context());
  const completed = await f.director.processJob(job.id);
  assert.equal(completed.status, "needs_review");
  assert.equal(completed.result.article.body, frozenText);
  assert.deepEqual(model.calls.map(([phase]) => phase),
    ["outline", "section", "section", "section", "preflight", "repair", "preflight", "final"]);
  for (const [, input] of model.calls) {
    assert.deepEqual(input.stylePolicy, job.stylePolicy);
    assert.deepEqual(input.brief.stylePolicy, job.stylePolicy);
  }
  const repair = model.calls.find(([phase]) => phase === "repair")[1];
  assert.deepEqual(repair.findings[0].allowedChanges, ["paragraph:1"]);
  assert.deepEqual(completed.result.article.sections[0].paragraphs.slice(1), repair.currentSection.paragraphs.slice(1));
  assert.deepEqual(completed.result.stylePolicy, job.stylePolicy);
  const finalReport = completed.reports.find(row => row.phase === "quality.final");
  assert.deepEqual(finalReport.stylePolicy, job.stylePolicy);
  assert.match(finalReport.styleAuditContextHash, /^[a-f0-9]{64}$/);
  assert.equal(completed.result.styleAuditReportHash, finalReport.reportHash);

  await f.store.mutate({ type: "fixture.stale_style_report", actor: "test" }, state => {
    const report = state.contentAuditReports.find(row => row.id === finalReport.id);
    report.stylePolicy = resolveArticleProsePolicy({ artifactKind: "article", language: "zh-CN", intent: "小院日记" });
    const { reportHash, ...payload } = report;
    report.reportHash = hashObject(payload);
  });
  const acceptance = { reviewed: true, contentHash: completed.result.contentHash };
  await assert.rejects(f.director.approveJob(job.id, acceptance, { ...context(), ifMatch: completed.etag }),
    { code: "CONTENT_FINAL_AUDIT_REQUIRED" });
  await f.store.mutate({ type: "fixture.return_exact_style_report", actor: "test" }, state => {
    const index = state.contentAuditReports.findIndex(row => row.id === finalReport.id);
    state.contentAuditReports[index] = finalReport;
  });
  const approved = await f.director.approveJob(job.id, acceptance, { ...context(), ifMatch: completed.etag });
  assert.equal(approved.status, "approved");
  assert.deepEqual(approved.review.stylePolicy, job.stylePolicy);
  assert.equal(approved.review.styleAuditReportHash, finalReport.reportHash);
});

test("preflight and terminal audit cannot advance a styled article with unchecked expression coverage", async t => {
  for (const phase of ["preflight", "final"]) {
    await t.test(phase, async child => {
      const model = new StubModel();
      const audit = model.auditArticle.bind(model);
      const unchecked = async input => {
        const result = await audit(input);
        result.value.coverage.expression = "unverified";
        return result;
      };
      if (phase === "preflight") model.auditArticle = unchecked;
      else model.finalAuditArticle = unchecked;
      const f = await fixture(child, model);
      const job = await f.director.createJob({
        intent: "写一篇有材料依据的小院日常文章",
        claimIds: ["C003"],
        targetLength: { minCharacters: 1500, maxCharacters: 2500 },
      }, context());
      if (phase === "final") {
        const waiting = await f.director.processJob(job.id);
        await bindFixtureArticleIllustrations(f.director, waiting, context());
      }
      await assert.rejects(f.director.processJob(job.id), { code: "CONTENT_STYLE_COVERAGE_INVALID" });
      const failed = await f.director.getJob(job.id);
      assert.equal(failed.status, "failed");
      assert.equal(failed.result, null);
      assert.equal(failed.reports.length, phase === "preflight" ? 0 : 1);
      assert.equal(failed.steps.find(row => row.status === "failed").auditUsage.total_tokens, 1);
    });
  }
});

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
  assert.equal(job.route.visualForm.mode, "technical");
  assert.deepEqual(job.route.visualForm.kinds, ["architecture"]);
  const completed = await processIllustratedArticle(f.director, job.id, context());
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
  const diagrams = completed.result.visuals.filter(visual => visual.spec.kind === "architecture");
  assert.equal(diagrams.length, 1);
  assert.equal(completed.result.visuals.filter(visual => visual.spec.kind === "editorial_illustration").length, 3);
  const svg = await f.director.readArtifact(job.id, `${diagrams[0].id}.svg`);
  assert.equal(svg.mime, "image/svg+xml");
  assert.match(svg.bytes.toString("utf8"), /Agent 产品工程闭环/);
  const png = await f.director.readArtifact(job.id, `${diagrams[0].id}.png`);
  assert.equal(png.mime, "image/png");
  assert.equal(png.bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.deepEqual(completed.result.article.visualSpecRefs, completed.result.visuals.map(visual => visual.id));
  assert.equal(completed.persona.id, "yao_ayi_yimeng_coffee_courtyard");
  assert.equal(completed.persona.version, "1.0.1");
  assert.match(completed.persona.documentSha256, /^[a-f0-9]{64}$/);
});

test("ordinary articles preserve drafted text while waiting for three verified scene images", async t => {
  const model = new StubModel();
  const unexpectedCalls = [];
  for (const method of ["planVisuals", "finalAuditArticle"]) {
    model[method] = async () => {
      unexpectedCalls.push(method);
      throw new Error(`unexpected model call: ${method}`);
    };
  }
  const f = await fixture(t, model);
  const job = await f.director.createJob({
    intent: "写一篇关于小院秋日生活的文章，并为正文配图",
    claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 },
  }, context());
  assert.equal(job.artifactKind, "article_visual");
  assert.equal(job.status, "queued");
  const handoff = job.route.articleIllustrations;
  assert.equal(handoff.minimum, 3);
  assert.equal(handoff.executor, "visual-designer");
  assert.equal(handoff.composeTool, "visualwrite.compose");
  const readback = await f.director.processJob(job.id);
  assert.equal(readback.id, job.id);
  assert.equal(readback.status, "needs_input");
  assert.equal(readback.result, null);
  assert.equal(readback.editorialIllustration.status, "waiting_for_images");
  assert.equal(readback.editorialIllustration.minImages, 3);
  assert.match(readback.editorialIllustration.draftHash, /^[a-f0-9]{64}$/u);
  assert.ok(readback.steps.some(step => step.kind === "section.draft" && step.status === "succeeded"));
  assert.ok(readback.reports.some(report => report.phase === "quality.review"));
  assert.equal(readback.reports.some(report => report.phase === "quality.final"), false);
  assert.equal(readback.steps.some(step => ["visual.plan", "visual.render", "package.freeze"].includes(step.kind)), false);
  assert.deepEqual(f.store.snapshot().visualSpecs, []);
  assert.deepEqual(unexpectedCalls, []);
});

test("article review requires three distinct, decodable and section-bound images", async t => {
  let scenario = "two";
  const fixtureVerifier = async input => {
    const verified = await fixtureArticleIllustrationVerifier(input);
    const [first, second, third] = verified.images;
    if (scenario === "two") verified.images = [first, second];
    if (scenario === "duplicate") {
      verified.images = [first, { ...second, bytes: first.bytes, sha256: first.sha256 }, third];
    }
    if (scenario === "same-pixels") {
      const reencoded = await sharp(first.bytes).png({ compressionLevel: 0 }).toBuffer();
      const sha256 = createHash("sha256").update(reencoded).digest("hex");
      assert.notEqual(sha256, first.sha256);
      verified.images = [first, { ...second, bytes: reencoded, sha256 }, third];
    }
    if (scenario === "placeholder") {
      const placeholder = Buffer.from("图片稍后补齐");
      verified.images = [first, second, { ...third, bytes: placeholder, sha256: createHash("sha256").update(placeholder).digest("hex") }];
    }
    if (scenario === "wrong-section") {
      verified.images = [first, second, { ...third, sectionKey: "not-a-draft-section" }];
    }
    if (scenario === "placeholder-caption") {
      verified.images = [first, second, { ...third, caption: "此处配图待补充" }];
    }
    return verified;
  };
  const f = await fixture(t, new StubModel(), fixtureVerifier);
  const job = await f.director.createJob({
    intent: "围绕小院的日常写一篇文章",
    explicitKind: "article",
    claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 },
  }, context());
  const waiting = await f.director.processJob(job.id);
  for (scenario of ["two", "duplicate", "same-pixels", "placeholder", "wrong-section", "placeholder-caption"]) {
    await assert.rejects(bindFixtureArticleIllustrations(f.director, waiting, context()), {
      code: /^ARTICLE_ILLUSTRATION_/u,
    }, scenario);
    const current = await f.director.getJob(job.id);
    assert.equal(current.editorialIllustration.status, "waiting_for_images", scenario);
    assert.equal(current.result, null, scenario);
    assert.deepEqual(f.store.snapshot().visualSpecs, [], scenario);
    const files = await readdir(join(f.directory, "content-director", job.id));
    assert.equal(files.some(name => /\.(png|jpg)$/u.test(name)), false, scenario);
  }
  scenario = "valid";
  const bindingContext = context();
  const bound = await bindFixtureArticleIllustrations(f.director, waiting, bindingContext);
  assert.equal(bound.id, waiting.id);
  assert.equal(bound.editorialIllustration.status, "bound");
  const replay = await bindFixtureArticleIllustrations(f.director, waiting, bindingContext);
  assert.deepEqual(replay.editorialIllustration, bound.editorialIllustration);
  const reviewed = await f.director.processJob(job.id);
  assert.equal(reviewed.status, "needs_review");
  assert.equal(reviewed.review, null);
  assert.equal(reviewed.result.visuals.length, 3);
  assert.deepEqual(reviewed.result.article.visualSpecRefs, reviewed.result.visuals.map(visual => visual.id));
  assert.equal(new Set(reviewed.result.visuals.map(visual => visual.artifacts[0].sha256)).size, 3);
  for (const visual of reviewed.result.visuals) {
    const image = await f.director.readArtifact(job.id, `${visual.id}.png`);
    assert.equal(image.mime, "image/png");
    assert.equal(image.bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  }
  const firstImage = reviewed.result.visuals[0].artifacts[0];
  await appendFile(join(f.directory, "content-director", job.id, firstImage.name), "changed");
  await assert.rejects(f.director.approveJob(job.id, {
    reviewed: true,
    contentHash: reviewed.result.contentHash,
  }, { ...context(), ifMatch: reviewed.etag }), { code: "CONTENT_ARTIFACT_CHANGED" });
});

test("a technical article rejects a rendered-form mismatch before producing any image", async t => {
  const f = await fixture(t);
  const job = await f.director.createJob({
    intent: "写一篇技术文章解释工程交付，并配一张柱状图",
    claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 },
  }, context());
  assert.equal(job.route.visualForm.mode, "technical");
  assert.deepEqual(job.route.visualForm.kinds, ["chart"]);
  // StubModel deliberately returns an architecture diagram instead of the requested chart.
  await assert.rejects(processIllustratedArticle(f.director, job.id, context()), { code: "ARTICLE_VISUAL_FORM_MISMATCH" });
  const failed = await f.director.getJob(job.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.result, null);
  assert.equal(failed.steps.some(step => step.kind === "visual.render"), false);
  assert.equal(f.store.snapshot().visualSpecs.some(visual => visual.spec.kind === "architecture"), false);
});

test("historical editorial illustrations made of text cards remain readable but cannot advance through review", async t => {
  const model = new StubModel();
  model.planVisuals = async () => ({
    value: {
      visuals: [{
        kind: "infographic",
        title: "今日小院",
        alt: "两张正文摘录文字卡片",
        caption: "正文摘录",
        items: [{ label: "小院", description: "先把院子扫干净。" }, { label: "待客", description: "来坐坐，先喝口水。" }],
      }],
    },
    receipt: modelReceipt("legacy-text-card"),
  });
  const f = await fixture(t, model);
  const job = await f.director.createJob({
    intent: "写一篇小院文章，并配一张信息图",
    claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 },
  }, context());
  const finished = await processIllustratedArticle(f.director, job.id, context());
  assert.equal(finished.status, "needs_review");
  const { contentHash } = finished.result;
  const card = finished.result.visuals.find(visual => visual.spec.kind === "infographic");
  const approved = await f.director.approveJob(job.id, { reviewed: true, contentHash }, { ...context(), ifMatch: finished.etag });
  const genericIntent = "写一篇小院文章，并为正文配图";
  // Simulate a previously queued package with a pre-gate route and real frozen card artifacts.
  await f.store.mutate({ type: "fixture.legacy_visual_intent", actor: "isolated reviewer" }, state => {
    const row = state.contentDirectorJobs.find(item => item.id === job.id);
    row.status = "needs_review";
    row.review = null;
    row.input.intent = genericIntent;
    row.route.intent = genericIntent;
    delete row.editorialIllustration;
    delete row.route.visualForm;
    const { routeHash, ...route } = row.route;
    row.route.routeHash = hashObject(route);
  });
  const pending = await f.director.getJob(job.id);
  assert.equal(pending.status, "needs_review");
  assert.equal(pending.visualGate.approvalEligible, false);
  assert.deepEqual(f.director.listJobs().items.find(item => item.id === job.id).visualGate, pending.visualGate);
  assert.equal(pending.result.contentHash, contentHash);
  assert.ok(pending.result.article.visualSpecRefs.includes(card.id));
  assert.equal((await f.director.readArtifact(job.id, `${card.id}.png`)).mime, "image/png");
  await assert.rejects(f.director.approveJob(job.id, { reviewed: true, contentHash }, { ...context(), ifMatch: pending.etag }), {
    code: "EDITORIAL_VISUAL_DESIGN_REQUIRED",
  });
  await assert.rejects(f.director.reviseVisuals(job.id, { orderedVisualIds: [card.id], updates: [] }, { ...context(), ifMatch: pending.etag }), {
    code: "EDITORIAL_VISUAL_DESIGN_REQUIRED",
  });
  await f.store.mutate({ type: "fixture.legacy_visual_approval", actor: "isolated reviewer" }, state => {
    const row = state.contentDirectorJobs.find(item => item.id === job.id);
    row.status = approved.status;
    row.review = approved.review;
  });
  const legacyApproved = await f.director.getJob(job.id);
  await assert.rejects(f.director.materializeEdition(job.id, {
    contentHash,
    visualRightsConfirmed: true,
    visualRightsNote: "Fixture only.",
  }, { ...context(), ifMatch: legacyApproved.etag }), { code: "EDITORIAL_VISUAL_DESIGN_REQUIRED" });
  assert.equal((await f.director.getJob(job.id)).status, "approved");
  assert.deepEqual(f.store.snapshot().editions, []);
  assert.deepEqual(f.store.snapshot().mediaAssets, []);
});

test("starting an exact historical article reuses the same Job and its frozen text without model calls", async t => {
  const model = new StubModel();
  const f = await fixture(t, model);
  const job = await f.director.createJob({
    intent: "围绕小院日常写一篇文章",
    explicitKind: "article",
    claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 },
  }, context());
  await f.store.mutate({ type: "fixture.pre_prose_policy_job", actor: "test" }, state => {
    delete state.contentDirectorJobs.find(row => row.id === job.id).stylePolicy;
  });
  const completed = await processIllustratedArticle(f.director, job.id, context());
  assert.equal(Object.hasOwn(completed, "stylePolicy"), false);
  assert.equal(Object.hasOwn(completed.result, "stylePolicy"), false);
  assert.equal(completed.reports.some(row => Object.hasOwn(row, "stylePolicy")), false);
  const { articleDraft } = await f.director.getJob(job.id);
  const article = { ...(articleDraft?.article ?? completed.result.article), visualSpecRefs: [] };
  delete article.visualBundleHash;
  const { title, summary, body, sections, visualSpecRefs } = article;
  const oldHash = hashObject({ persona: completed.persona, title, summary, body, sections, visualSpecRefs });
  const historicPackage = { ...completed.result, article, visuals: [], contentHash: oldHash };
  const bytes = Buffer.from(JSON.stringify(historicPackage, null, 2) + "\n");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifact = { id: `CDA-${sha256.slice(0, 24)}`, name: "legacy-package.json", mime: "application/json", bytes: bytes.length, sha256 };
  await writeFile(join(f.directory, "content-director", job.id, artifact.name), bytes, { mode: 0o600, flag: "wx" });
  await f.store.mutate({ type: "fixture.legacy_article", actor: "isolated reviewer" }, state => {
    const row = state.contentDirectorJobs.find(item => item.id === job.id);
    row.resultRef = artifact;
    row.resultHash = oldHash;
    row.visualSpecIds = [];
    row.editorialIllustration = null;
    row.artifacts.push(artifact);
  });
  const legacy = await f.director.getJob(job.id);
  assert.equal(legacy.status, "needs_review");
  assert.equal(legacy.visualGate.approvalEligible, false);
  for (const method of ["generateOutline", "draftSection", "auditArticle", "finalAuditArticle", "planVisuals"]) {
    model[method] = async () => { assert.fail(`historical staging unexpectedly called ${method}`); };
  }
  await assert.rejects(f.director.startJob(job.id, { ...context(), ifMatch: job.etag }), { code: "PRECONDITION_FAILED" });
  const operation = { ...context(), ifMatch: legacy.etag };
  const staged = await f.director.startJob(job.id, operation);
  assert.equal(staged.id, job.id);
  assert.equal(staged.status, "needs_input");
  assert.equal(staged.editorialIllustration.status, "waiting_for_images");
  assert.equal(staged.editorialIllustration.minImages, 3);
  assert.equal(staged.articleDraft.article.body, body);
  assert.deepEqual(staged.articleDraft.article.sections, sections);
  assert.equal(staged.editorialIllustration.previousResultHash, oldHash);
  assert.deepEqual(staged.editorialIllustration.previousResultRef, artifact);
  assert.equal(staged.result, null);
  assert.deepEqual(staged.visualSpecIds, []);
  assert.deepEqual((await f.director.readArtifact(job.id, artifact.name)).bytes, bytes);
  const replay = await f.director.startJob(job.id, operation);
  assert.equal(replay.editorialIllustration.requestId, staged.editorialIllustration.requestId);
  assert.deepEqual(replay.reports, legacy.reports);
  assert.equal(f.store.snapshot().contentDirectorJobs.length, 1);
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
  const completed = await processIllustratedArticle(f.director, job.id, context());
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
  const drafted = await f.director.processJob(job.id);
  assert.equal(drafted.editorialIllustration.status, "waiting_for_images");
  // Install a pre-gate report before freezing the new draft that will bind the design.
  const { result: historical } = await f.store.mutate({ type: "fixture.legacy_audit", actor: "isolated reviewer" }, state => {
    const legacy = state.contentDirectorJobs.find(row => row.id === job.id);
    legacy.editorialIllustration = null;
    legacy.status = "failed";
    legacy.missing = [];
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
  const legacy = await f.director.getJob(job.id);
  await f.director.startJob(job.id, { ...context(), ifMatch: legacy.etag });
  await assert.rejects(processIllustratedArticle(f.director, job.id, context()), /fixture visual plan interrupted/u);
  const failed = await f.director.getJob(job.id);
  assert.equal(failed.status, "failed");
  await f.director.startJob(job.id, { ...context(), ifMatch: failed.etag });
  const completed = await f.director.processJob(job.id);
  assert.equal(completed.id, job.id);
  assert.equal(completed.status, "needs_review");
  assert.equal(model.preflights, 1);
  assert.equal(model.visualPlans, 2);
  assert.deepEqual(completed.reports.find(report => report.id === historical.id), historical);
  assert.equal(completed.findings.some(row => row.code === "MISSING_VISUAL_SPEC_AND_DISCLOSURE"), false);
  assert.deepEqual(completed.result.article.visualSpecRefs, completed.result.visuals.map(visual => visual.id));
  assert.equal(completed.result.visuals.filter(visual => visual.spec.kind === "architecture").length, 1);
  assert.equal(completed.result.visuals.filter(visual => visual.spec.kind === "editorial_illustration").length, 3);
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
      const completed = await processIllustratedArticle(f.director, job.id, context());
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

test("verified illustrations and optional technical diagrams are imported into the materialized edition", async t => {
  const f = await fixture(t);
  const job = await f.director.createJob({
    intent: "围绕 Agent 产品如何进入真实业务写一篇文章，并配一张系统架构图",
    claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 },
  }, context());
  const completed = await processIllustratedArticle(f.director, job.id, context());
  await f.director.approveJob(job.id, { reviewed: true, contentHash: completed.result.contentHash }, { ...context(), ifMatch: completed.etag });
  const materialized = await f.director.materializeEdition(job.id, {
    contentHash: completed.result.contentHash,
    visualRightsConfirmed: true,
    visualRightsNote: "Isolated generated fixture reviewed for exact content, rights and privacy.",
  }, { ...context(), ifMatch: (await f.director.getJob(job.id)).etag });
  assert.equal(materialized.edition.assetRefs.length, 4);
  assert.equal(materialized.edition.assetRefs[0].role, "image");
  assert.equal(f.mediaAssets.getAsset(materialized.edition.assetRefs[0].assetId).status, "reviewed");
  assert.ok(materialized.edition.blocks.some(block => block.type === "image"));
});

test("visual materialization omits a generated name that resembles private metadata and replays a legacy named upload", async t => {
  const model = new StubModel();
  const plan = await model.planVisuals();
  plan.value.visuals.push({
    ...plan.value.visuals[0],
    kind: "flow",
    title: "审核与回执流程",
    alt: "从任务输入到审核和回执的流程图",
    caption: "图 2：流程和回执",
  });
  model.planVisuals = async () => plan;
  const f = await fixture(t, model);
  const ctx = context();
  // Pin the Job ID so the second normally rendered file always matches the phone pattern.
  const fixedId = Buffer.from("00000000000000000034", "hex");
  const random = t.mock.method(crypto, "randomBytes", () => fixedId, { times: 1 });
  syncBuiltinESMExports();
  let job;
  try {
    job = await f.director.createJob({
      intent: "只做两张图：架构图和流程图",
      explicitKind: "pure_visual",
      claimIds: ["C003"],
    }, ctx);
  } finally {
    random.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(job.id, `CDJ-${fixedId.toString("hex")}`);
  const pending = await f.director.processJob(job.id);
  const [legacyVisual, unnamedVisual] = pending.result.visuals;
  const legacyImage = legacyVisual.artifacts.find(artifact => artifact.mime === "image/png");
  const unnamedImage = unnamedVisual.artifacts.find(artifact => artifact.mime === "image/png");
  assert.deepEqual(scanSensitiveText(legacyImage.name), []);
  assert.deepEqual(scanSensitiveText(unnamedImage.name).map(finding => finding.kind), ["phone"]);
  const legacyFile = await f.director.readArtifact(job.id, legacyImage.name);
  const unnamedFile = await f.director.readArtifact(job.id, unnamedImage.name);
  await assert.rejects(f.mediaAssets.upload(Readable.from([unnamedFile.bytes]), {
    contentType: unnamedImage.mime,
    name: unnamedImage.name,
  }, context()), { code: "MEDIA_SENSITIVE_METADATA" });
  const staged = await f.mediaAssets.upload(Readable.from([legacyFile.bytes]), {
    contentType: legacyImage.mime,
    contentLength: legacyFile.bytes.length,
    name: legacyImage.name,
    expectedSha256: legacyImage.sha256,
  }, {
    ...ctx,
    idempotencyKey: hashObject({ jobId: job.id, visualId: legacyVisual.id, action: "upload" }),
  });
  const approved = await f.director.approveJob(job.id, {
    reviewed: true,
    contentHash: pending.result.contentHash,
  }, { ...context(), ifMatch: pending.etag });
  const materialized = await f.director.materializeEdition(job.id, {
    contentHash: pending.result.contentHash,
    visualRightsConfirmed: true,
    visualRightsNote: "Isolated rendered fixture reviewed for exact content and rights.",
  }, { ...context(), ifMatch: approved.etag });
  const assets = materialized.edition.assetRefs.map(ref => f.mediaAssets.getAsset(ref.assetId));
  assert.deepEqual(assets.map(asset => asset.sha256), [legacyImage.sha256, unnamedImage.sha256]);
  assert.deepEqual(assets.map(asset => asset.status), ["reviewed", "reviewed"]);
  assert.equal(assets[0].id, staged.id);
  assert.equal(assets[0].name, legacyImage.name);
  assert.equal(Object.hasOwn(assets[1], "name"), false);
  assert.equal(f.mediaAssets.listAssets().items.length, 2);
});

test("approved article materializes as an immutable editorial edition", async t => {
  const f = await fixture(t);
  const job = await f.director.createJob({
    intent: "围绕 Agent 产品进入真实业务写一篇技术文章",
    claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 },
  }, context());
  const completed = await processIllustratedArticle(f.director, job.id, context());
  const approved = await f.director.approveJob(job.id, { reviewed: true, contentHash: completed.result.contentHash, note: "read complete package" }, { ...context(), ifMatch: completed.etag });
  assert.equal(approved.status, "approved");
  const materialized = await f.director.materializeEdition(job.id, {
    contentHash: completed.result.contentHash,
    visualRightsConfirmed: true,
    visualRightsNote: "Isolated generated fixture reviewed for rights and privacy.",
  }, { ...context(), ifMatch: approved.etag });
  assert.equal(materialized.edition.format, "article");
  assert.equal(materialized.edition.body, completed.result.article.body);
  assert.equal(f.editorial.getEdition(materialized.edition.id).snapshotHash, materialized.edition.snapshotHash);
});
