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

const context = () => ({ method: "local", actor: "isolated content director reviewer", idempotencyKey: randomUUID() });

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
  const f = await fixture(t);
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
  assert.equal(completed.result.findings.length, 0);
  assert.equal(completed.result.visuals.length, 1);
  const svg = await f.director.readArtifact(job.id, `${completed.result.visuals[0].id}.svg`);
  assert.equal(svg.mime, "image/svg+xml");
  assert.match(svg.bytes.toString("utf8"), /Agent 产品工程闭环/);
  assert.equal(completed.persona.id, "yao_ayi_yimeng_coffee_courtyard");
  assert.equal(completed.persona.version, "1.0.1");
  assert.match(completed.persona.documentSha256, /^[a-f0-9]{64}$/);
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

test("audit model retries invalid finding enums once and preserves rejected response evidence", async () => {
  const calls = [];
  const deepSeek = {
    async completeTask(options) {
      calls.push(options);
      const accepted = calls.length === 2;
      return {
        value: {
          assessment: "needs revision",
          findings: [{
            severity: accepted ? "major" : "high",
            dimension: "facts",
            code: "UNSUPPORTED_FACT",
            location: "section:0",
            message: "Unsupported fact.",
            allowedChanges: ["section:0"],
          }],
          coverage: { facts: "checked", structure: "checked", expression: "checked", policy: "checked", technical: "checked", visual: "checked" },
        },
        requestedModel: "fixture",
        resolvedModel: "fixture",
        responseId: accepted ? "accepted" : "rejected",
        responseHash: accepted ? "a".repeat(64) : "b".repeat(64),
        usage: { totalTokens: 1 },
        attempts: [],
      };
    },
  };
  const model = new ContentDirectorModel({ deepSeek });
  const result = await model.finalAuditArticle({});
  assert.equal(calls.length, 2);
  assert.equal(result.value.findings[0].severity, "major");
  assert.match(calls[1].messages.at(-1).content, /Correct only the JSON schema and enum formatting/);
  assert.ok(result.receipt.attempts.some(attempt => attempt.type === "audit_schema_rejected" && attempt.responseId === "rejected"));
});

test("audit model fails closed when the schema correction remains invalid", async () => {
  let calls = 0;
  const deepSeek = {
    async completeTask() {
      calls += 1;
      return {
        value: {
          assessment: "invalid",
          findings: [{ severity: "high", dimension: "facts", allowedChanges: [] }],
          coverage: {},
        },
        requestedModel: "fixture",
        resolvedModel: "fixture",
      };
    },
  };
  const model = new ContentDirectorModel({ deepSeek });
  await assert.rejects(model.auditArticle({}), /severity is invalid/);
  assert.equal(calls, 2);
});

test("preflight ignores only not-yet-generated visual findings and proceeds to rendering", async t => {
  class PreflightVisualModel extends StubModel {
    reviewCalls = 0;
    async auditArticle() {
      this.reviewCalls += 1;
      const result = await super.auditArticle();
      if (this.reviewCalls === 1) {
        result.value.findings = [{
          severity: "major",
          dimension: "disclosure",
          code: "MISSING_VISUAL_SPEC_AND_DISCLOSURE",
          location: "visualSpecRefs",
          message: "Visuals have not been generated yet.",
          allowedChanges: [],
        }];
      }
      return result;
    }
  }
  const f = await fixture(t, new PreflightVisualModel());
  const job = await f.director.createJob({
    intent: "围绕 Agent 产品进入真实业务写一篇文章，并配一张系统架构图",
    claimIds: ["C003"],
    targetLength: { minCharacters: 500, maxCharacters: 2500 },
  }, context());
  const completed = await f.director.processJob(job.id);
  assert.equal(completed.status, "needs_review");
  assert.equal(completed.result.visuals.length, 1);
  assert.equal(completed.result.article.visualSpecRefs.length, 1);
});

test("final audit keeps visual absence findings after rendering", async t => {
  class FinalVisualModel extends StubModel {
    async finalAuditArticle() {
      const result = await super.auditArticle();
      result.value.findings = [{
        severity: "major",
        dimension: "disclosure",
        code: "MISSING_VISUAL_SPEC_AND_DISCLOSURE",
        location: "visualSpecRefs",
        message: "The final package has no valid visual disclosure.",
        allowedChanges: [],
      }];
      return result;
    }
  }
  const f = await fixture(t, new FinalVisualModel());
  const job = await f.director.createJob({
    intent: "围绕 Agent 产品进入真实业务写一篇文章，并配一张系统架构图",
    claimIds: ["C003"],
    targetLength: { minCharacters: 500, maxCharacters: 2500 },
  }, context());
  const completed = await f.director.processJob(job.id);
  assert.equal(completed.status, "blocked");
  assert.equal(completed.result.visuals.length, 1);
  assert.ok(completed.findings.some(finding => finding.code === "MISSING_VISUAL_SPEC_AND_DISCLOSURE"));
});

test("global length findings receive a bounded section repair scope", async t => {
  class GlobalLengthModel extends StubModel {
    reviewCalls = 0;
    repairInputs = [];
    async auditArticle() {
      this.reviewCalls += 1;
      const result = await super.auditArticle();
      if (this.reviewCalls === 1) {
        result.value.findings = [{
          severity: "major",
          dimension: "structure",
          code: "BELOW_TARGET_LENGTH",
          location: "全文",
          message: "全文字符篇幅低于目标。",
          allowedChanges: [],
        }];
      }
      return result;
    }
    async repairSection(input) {
      this.repairInputs.push(input);
      return {
        value: input.currentSection,
        receipt: { requestedModel: "fixture", resolvedModel: "fixture", responseId: "repair", requestHash: "3".repeat(64), responseHash: "4".repeat(64), usage: { total_tokens: 1 } },
      };
    }
  }
  const model = new GlobalLengthModel();
  const f = await fixture(t, model);
  const job = await f.director.createJob({
    intent: "围绕 Agent 产品进入真实业务写一篇技术文章",
    claimIds: ["C003"],
    targetLength: { minCharacters: 500, maxCharacters: 2500 },
  }, context());
  const completed = await f.director.processJob(job.id);
  assert.equal(completed.status, "needs_review");
  assert.equal(model.repairInputs.length, 1);
  assert.deepEqual(model.repairInputs[0].findings[0].allowedChanges, ["section:1"]);
});
