import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { Readable } from "node:stream";
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
import { createContentVideoHandoff } from "../src/video-runtime/content-video-router.mjs";

const RECEIPT = {
  requestedModel: "advanced-fixture",
  resolvedModel: "advanced-fixture",
  responseId: "advanced",
  requestHash: "a".repeat(64),
  responseHash: "b".repeat(64),
  usage: { total_tokens: 1 },
};

const paragraph = (topic, key, part) =>
  `${part}。这是「${topic}」在 ${key} 场景中的完整说明，需要交代问题、权限、执行、失败恢复、人工责任和真实回执，不能只给抽象结论。第 ${key} 段还必须解释取舍、限制和不能自动化的边界，确保读者能够复核判断。`;

class AdvancedModel {
  constructor(options = {}) {
    this.options = options;
    this.activeDrafts = 0;
    this.maxActiveDrafts = 0;
    this.draftCalls = [];
    this.auditCalls = 0;
    this.firstDraftStarted = null;
    this.releaseFirstDraft = null;
    this.started = new Promise(resolve => { this.firstDraftStarted = resolve; });
    this.release = new Promise(resolve => { this.releaseFirstDraft = resolve; });
  }

  async generateOutline({ brief }) {
    if (brief.topic.includes("MODEL_FAILURE")) {
      const error = new Error("fixture model failure");
      error.code = "FIXTURE_MODEL_FAILURE";
      throw error;
    }
    return {
      value: {
        title: brief.topic.slice(0, 100),
        summary: "围绕真实问题、工程取舍和交付边界展开。",
        sections: [
          { key: "problem", title: "问题与约束", purpose: "界定问题", targetCharacters: 250, claimIds: [] },
          { key: "method", title: "方法与取舍", purpose: "说明方法和失败路径", targetCharacters: 300, claimIds: [] },
          { key: "delivery", title: "交付与验证", purpose: "说明回执边界", targetCharacters: 250, claimIds: [] },
        ],
      },
      receipt: RECEIPT,
    };
  }

  async draftSection({ brief, section }) {
    this.draftCalls.push(`${brief.topic}:${section.key}`);
    this.activeDrafts++;
    this.maxActiveDrafts = Math.max(this.maxActiveDrafts, this.activeDrafts);
    try {
      if (this.options.pauseFirst && this.draftCalls.length === 1) {
        this.firstDraftStarted();
        await this.release;
      }
      if (this.options.delayMs) await new Promise(resolve => setTimeout(resolve, this.options.delayMs));
      const retained = brief.mustKeep?.length ? `必须保留：${brief.mustKeep.join("；")}。` : "";
      const body = [`${paragraph(brief.topic, section.key, "先看真实问题")}${retained}`, paragraph(brief.topic, section.key, "再看工程取舍"), paragraph(brief.topic, section.key, "最后看交付")]
        .join("\n\n");
      return { value: { title: section.title, body, paragraphs: body.split("\n\n"), claimIds: [] }, receipt: RECEIPT };
    } finally {
      this.activeDrafts--;
    }
  }

  async auditArticle() {
    this.auditCalls++;
    if (this.options.repairFirst && this.auditCalls === 1) {
      return {
        value: {
          assessment: "A section needs a bounded repair.",
          findings: [{
            severity: "blocker",
            dimension: "structure",
            code: "FIXTURE_REPAIR_REQUIRED",
            location: "section:0",
            message: "The first section needs a bounded replacement.",
            allowedChanges: ["section:0"],
          }],
          coverage: { facts: "checked", structure: "blocked", expression: "checked", policy: "checked", technical: "checked", visual: "not-applicable" },
        },
        receipt: RECEIPT,
      };
    }
    return {
      value: {
        assessment: "No blocking findings.",
        findings: [],
        coverage: { facts: "checked", structure: "checked", expression: "checked", policy: "checked", technical: "checked", visual: "not-applicable" },
      },
      receipt: RECEIPT,
    };
  }

  async repairSection({ brief, section }) {
    const body = [paragraph(brief.topic, `${section.key}-repaired`, "修复后的目标段"), paragraph(brief.topic, `${section.key}-repaired`, "修复后的证据段"), paragraph(brief.topic, `${section.key}-repaired`, "修复后的边界段")]
      .join("\n\n");
    return { value: { title: section.title, body, paragraphs: body.split("\n\n"), claimIds: [] }, receipt: RECEIPT };
  }

  async planVisuals() {
    return {
      value: {
        visuals: [
          {
            kind: "architecture",
            title: "内容总控架构",
            alt: "内容总控连接文章、视觉和视频生产线的关系图",
            caption: "图 1：三条生产线",
            claimIds: [],
            nodes: [{ id: "director", label: "内容总控" }, { id: "article", label: "文章生产线" }, { id: "video", label: "视频生产线" }],
            edges: [{ from: "director", to: "article", label: "路由" }, { from: "director", to: "video", label: "路由" }],
          },
          {
            kind: "infographic",
            title: "审核与回执",
            alt: "说明审核后仍需独立发布回执的信息图",
            caption: "图 2：审核与回执分开",
            claimIds: [],
            items: [{ label: "审核", description: "核对完整内容" }, { label: "回执", description: "核对真实发布结果" }],
          },
        ],
      },
      receipt: RECEIPT,
    };
  }
}

const context = options => ({ method: "local", actor: "advanced fixture reviewer", idempotencyKey: randomUUID(), ...options });

async function fixture(t, model, { autoStart = false, contentOps = null, mode = "enabled" } = {}) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "pm-content-advanced-"));
  const store = new JsonStore({ filePath: join(directory, "state.json") });
  await store.open(() => loadSeedState(resolve(import.meta.dirname, "../data/seed")));
  await migrateEditorialState(store, { publicOrigin: "https://pengmanager.com" });
  const backup = createEditorialBackup({ store });
  await migrateContentOpsState(store, { beforeMigration: () => backup.captureCurrent() });
  await migrateContentDirectorState(store, { beforeMigration: () => backup.captureCurrent() });
  const geo = new GeoOsService({ store });
  await geo.approveClaim("C003", { approvedBy: "advanced fixture reviewer", publicLevel: "private" });
  const editorial = new EditorialService({ store, geoService: geo, publicOrigin: "https://pengmanager.com" });
  const director = new ContentDirectorService({
    store,
    model,
    editorial,
    contentOps,
    artifactRoot: join(directory, "content-director"),
    autoStart,
    mode,
  });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, editorial, director };
}

async function waitFor(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("TIMEOUT");
}

test("real uploaded markdown is hashed, persisted and bound into the Job", async t => {
  const model = new AdvancedModel();
  const f = await fixture(t, model);
  const bytes = Buffer.from("# Author material\n\nThis is real author-supplied source material.\n");
  const uploaded = await f.director.uploadAttachment(Readable.from([bytes]), {
    role: "document",
    mime: "text/markdown",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    name: "author-notes.md",
  }, context());
  assert.match(uploaded.id, /^CDU-[a-f0-9]{32}$/);
  assert.equal(uploaded.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal((await f.director.readAttachment(uploaded.id)).bytes.toString(), bytes.toString());
  const job = await f.director.createJob({
    intent: "根据真实作者材料写一篇文章",
    explicitKind: "article",
    attachments: [{ kind: "document", id: uploaded.id }],
    targetLength: { minCharacters: 500, maxCharacters: 1200 },
  }, context());
  assert.equal(job.input.attachments[0].sha256, uploaded.sha256);
  const completed = await f.director.processJob(job.id);
  assert.equal(completed.status, "needs_review");
  assert.equal(completed.steps.some(step => step.kind === "attachment.ingest"), true);
});

test("disabled content director preserves old services while refusing new work", async t => {
  const f = await fixture(t, new AdvancedModel(), { mode: "disabled" });
  assert.deepEqual(f.director.getStatus().enabled, false);
  assert.equal(f.director.getStatus().writable, false);
  await assert.rejects(f.director.resolveIntent({ intent: "写一篇文章" }), { code: "CONTENT_DIRECTOR_DISABLED" });
});

test("batch scheduler stays at two active Jobs and isolates one model failure", async t => {
  const model = new AdvancedModel({ delayMs: 15 });
  const f = await fixture(t, model, { autoStart: true });
  const batch = await f.director.createBatch({
    name: "parallel fixture",
    topics: ["写文章：任务一", "写文章：MODEL_FAILURE", "写文章：任务三", "写文章：任务四"].map(intent => ({ intent })),
    shared: {
      explicitKind: "article",
      claimIds: ["C003"],
      targetLength: { minCharacters: 500, maxCharacters: 1200 },
    },
  }, context());
  assert.equal(batch.jobs.length, 4);
  await waitFor(() => f.director.getBatch(batch.id).jobs.every(job => ["needs_review", "failed", "blocked"].includes(job.status)));
  const finalBatch = f.director.getBatch(batch.id);
  assert.equal(finalBatch.jobs.filter(job => job.status === "needs_review").length, 3);
  assert.equal(finalBatch.jobs.filter(job => job.status === "failed").length, 1);
  assert.ok(model.maxActiveDrafts <= 2, `max active drafts was ${model.maxActiveDrafts}`);
});

test("pause keeps the completed section checkpoint and resume finishes without a paid repeat", async t => {
  const model = new AdvancedModel({ pauseFirst: true });
  const f = await fixture(t, model, { autoStart: true });
  const job = await f.director.createJob({
    intent: "写一篇关于长任务恢复的技术文章",
    explicitKind: "article",
    claimIds: ["C003"],
    targetLength: { minCharacters: 500, maxCharacters: 1200 },
  }, context());
  await f.director.startJob(job.id, context());
  await model.started;
  const running = await f.director.getJob(job.id);
  await f.director.pauseJob(job.id, context({ ifMatch: running.etag }));
  model.releaseFirstDraft();
  const paused = await waitFor(async () => {
    const row = await f.director.getJob(job.id);
    return row.status === "needs_resume" ? row : null;
  }).catch(async error => {
    const row = await f.director.getJob(job.id);
    throw new Error(`${error.message}: ${row.status} pauseRequested=${row.pauseRequested} error=${JSON.stringify(row.error)}`, { cause: error });
  });
  await f.director.resumeJob(job.id, context({ ifMatch: paused.etag }));
  const completed = await waitFor(async () => {
    const row = await f.director.getJob(job.id);
    return row.status === "needs_review" ? row : null;
  }).catch(async error => {
    const row = await f.director.getJob(job.id);
    throw new Error(`${error.message}: after resume ${row.status} pauseRequested=${row.pauseRequested} error=${JSON.stringify(row.error)}`, { cause: error });
  });
  assert.equal(completed.status, "needs_review");
  assert.equal(model.draftCalls.filter(value => value.endsWith(":problem")).length, 1);
});

test("Brief edits and a manually frozen outline use exact ETags and drive the final sections", async t => {
  const model = new AdvancedModel();
  const f = await fixture(t, model);
  const job = await f.director.createJob({
    intent: "写一篇关于内容治理的技术文章",
    explicitKind: "article",
    claimIds: ["C003"],
    targetLength: { minCharacters: 500, maxCharacters: 1200 },
  }, context());
  const patched = await f.director.patchBrief(job.id, {
    goal: "解释权限、证据、审核和回执的边界",
    authorThoughts: ["用户中心思想不能被改写"],
    mustKeep: ["用户中心思想不能被改写"],
  }, context({ ifMatch: job.etag }));
  const outline = {
    title: "内容治理的四个边界",
    summary: "从权限、证据、审核和回执解释可核验内容治理。",
    sections: [
      { key: "authority", title: "权限边界", purpose: "解释谁可以动作", targetCharacters: 250, claimIds: ["C003"] },
      { key: "evidence", title: "证据边界", purpose: "解释事实来源", targetCharacters: 300, claimIds: ["C003"] },
      { key: "receipt", title: "回执边界", purpose: "解释完成证明", targetCharacters: 250, claimIds: ["C003"] },
    ],
  };
  const frozen = await f.director.freezeOutline(job.id, { outline }, context({ ifMatch: patched.etag }));
  assert.equal(frozen.outlineRef.hash, (await import("../src/domain/hash.mjs")).hashObject(outline));
  const completed = await f.director.processJob(job.id);
  assert.deepEqual(completed.result.article.sections.map(section => section.key), ["authority", "evidence", "receipt"]);
  assert.equal(completed.result.findings.some(finding => finding.code === "MUST_KEEP_MISSING"), false);
});

test("model blocker triggers a bounded repair and a fresh final audit", async t => {
  const model = new AdvancedModel({ repairFirst: true });
  const f = await fixture(t, model);
  const job = await f.director.createJob({
    intent: "写一篇关于定点修复的技术文章",
    explicitKind: "article",
    claimIds: ["C003"],
    targetLength: { minCharacters: 500, maxCharacters: 1200 },
  }, context());
  const result = await f.director.processJob(job.id);
  assert.equal(result.status, "needs_review");
  assert.equal(result.steps.some(step => step.kind === "article.repair"), true);
  assert.equal(f.store.snapshot().contentRepairAttempts.length, 1);
  assert.equal(result.reports.some(report => report.phase === "quality.final" && report.contentHash === result.result.contentHash), true);
});

test("an approved visual package can be reordered without overwriting the previous revision", async t => {
  const model = new AdvancedModel();
  const f = await fixture(t, model);
  const job = await f.director.createJob({
    intent: "写一篇内容系统文章，并配两张可编辑图",
    explicitKind: "article_visual",
    claimIds: ["C003"],
    targetLength: { minCharacters: 500, maxCharacters: 1200 },
    enableVisuals: true,
  }, context());
  const first = await f.director.processJob(job.id);
  assert.equal(first.result.visuals.length, 2);
  const ids = first.result.visuals.map(row => row.id);
  const revised = await f.director.reviseVisuals(job.id, {
    orderedVisualIds: [...ids].reverse(),
    updates: [],
  }, context({ ifMatch: first.etag }));
  assert.deepEqual(revised.result.visuals.map(row => row.id), [...ids].reverse());
  assert.notEqual(revised.result.contentHash, first.result.contentHash);
  assert.equal(revised.status, "needs_review");
  assert.equal(f.store.snapshot().contentDirectorRevisions.some(row => row.kind === "visuals"), true);
});

test("pure visual and video jobs freeze readable private result artifacts", async t => {
  const model = new AdvancedModel();
  const f = await fixture(t, model);
  const visualJob = await f.director.createJob({
    intent: "做一张内容生产线架构图，不要文章",
    explicitKind: "pure_visual",
  }, context());
  const visual = await f.director.processJob(visualJob.id);
  assert.equal(visual.status, "needs_review");
  assert.equal(visual.result.visuals.length, 2);
  const videoJob = await f.director.createJob({
    intent: "做一条 30 秒 AI 生成的品牌短视频",
    explicitKind: "video_ai",
    durationSec: 30,
  }, context());
  const video = await f.director.processJob(videoJob.id);
  assert.equal(video.status, "needs_input");
  assert.equal(video.result.videoPlan.productionVerified, false);
  assert.equal(video.result.videoPlan.handoff.productionAuthorized, false);
});

test("completed Edition can be handed to the existing content-ops planner without publication authority", async t => {
  const model = new AdvancedModel();
  const contentOps = {
    planTemplate(input) {
      assert.equal(typeof input.editionId, "string");
      return {
        plan: {
          schema: "pengmanager.adaptation-plan/v1",
          storyRef: { id: input.storyId },
          motherEditionRefs: [{ id: input.editionId }],
          targets: input.targets.map(target => ({ ...target, decision: "needs_input" })),
          mode: "prepare",
          containsCommands: false,
        },
        gaps: [{ code: "RULES_REVIEW_REQUIRED", inputKey: "rulesRef", explanation: "fixture gap" }],
        sourceRefs: {},
      };
    },
  };
  const f = await fixture(t, model, { contentOps });
  const job = await f.director.createJob({
    intent: "写一篇关于内容交接的技术文章",
    explicitKind: "article",
    claimIds: ["C003"],
    targetLength: { minCharacters: 500, maxCharacters: 1200 },
  }, context());
  const reviewed = await f.director.processJob(job.id);
  const approved = await f.director.approveJob(job.id, {
    reviewed: true,
    contentHash: reviewed.result.contentHash,
    note: "Read the complete fixture package.",
  }, context({ ifMatch: reviewed.etag }));
  const materialized = await f.director.materializeEdition(job.id, {
    contentHash: approved.result.contentHash,
  }, context({ ifMatch: approved.etag }));
  assert.ok(materialized.edition.id);
  const completed = await f.director.getJob(job.id);
  const plan = await f.director.createContentOpsPlan(job.id, {
    targets: [{ destinationId: "DST-fixture", locale: "zh-CN", nativeForm: "article" }],
    goal: "Prepare a truthful platform adaptation.",
    budgetAuthorizationId: null,
    sourceArtifactIds: [],
    nativeInputs: [],
  }, context({ ifMatch: completed.etag }));
  assert.equal(plan.publicationAuthorized, false);
  assert.equal(plan.gaps[0].code, "RULES_REVIEW_REQUIRED");
  assert.equal(f.store.snapshot().contentPublishPackages.length, 1);
});

test("video router issues real executor handoffs without claiming production", () => {
  const ai = createContentVideoHandoff({
    id: "CDJ-ai",
    artifactKind: "video_ai",
    input: { intent: "生成一条 30 秒 AI 产品短片", durationSec: 30, attachments: [] },
    route: { videoSubroute: "marketing" },
  }, { capabilities: { ready: true, state: "ready", sourceMain: "fixture", categories: [] } });
  assert.equal(ai.route.executorId, "pengmanager.standard-video");
  assert.equal(ai.productionVerified, false);
  assert.equal(ai.productionAuthorized, false);
  const mixed = createContentVideoHandoff({
    id: "CDJ-mixed",
    artifactKind: "video_mixed",
    input: {
      intent: "实拍加 AI 混合视频",
      durationSec: 30,
      videoRightsConfirmed: true,
      attachments: [{ id: `CDU-${"a".repeat(32)}`, kind: "video", mime: "video/mp4", sha256: "b".repeat(64), size: 10 }],
    },
    route: {
      shotPlan: [
        { sourceType: "real_footage", durationSec: 15, attachmentId: `CDU-${"a".repeat(32)}`, authorizationId: "AUTH-1", description: "" },
        { sourceType: "ai_generated", durationSec: 15, attachmentId: null, description: "产品机制动画", authorizationId: null },
      ],
    },
  });
  assert.equal(mixed.route.shots.length, 2);
  assert.equal(mixed.route.totalDurationSec, 30);
  assert.equal(mixed.productionVerified, false);
});
