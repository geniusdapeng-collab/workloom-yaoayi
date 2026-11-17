import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { ApiError } from "../domain/errors.mjs";
import { hashObject } from "../domain/hash.mjs";
import { requirePublicUrl } from "../domain/public-url.mjs";
import { CONTENT_ARTIFACT_KINDS, resolveContentIntent } from "../domain/content-intent.mjs";
import {
  CONTENT_DIRECTOR_STATUSES,
  assertContentDirectorStateIntegrity,
  composeArticleBody,
  contentDirectorEntity,
  contentDirectorEtag,
  deterministicArticleFindings,
  normalizeArticleLength,
  splitSectionsFromMarkdown,
  validateOutline,
  validateSectionDraft,
} from "../domain/content-director.mjs";
import { JsonStore } from "../storage/json-store.mjs";
import { inspectProductionArtifact } from "./production-artifacts.mjs";
import { inspectRenderedVisual, mermaidSource, normalizeVisualPlan, renderVisualPng, renderVisualSvg } from "./visual-renderer.mjs";
import { createContentVideoHandoff } from "../video-runtime/content-video-router.mjs";

const ADMIN_METHODS = new Set(["local", "session"]);
const TERMINAL = new Set(["approved", "completed", "cancelled", "blocked", "failed", "unknown"]);
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ATTACHMENT_ID = /^CDU-[a-f0-9]{32}$/;
const MAX_JOBS_RUNNING = 2;
const MAX_SOURCE_MATERIAL_CHARACTERS = 120_000;
const attachmentQueues = new WeakMap();
const ATTACHMENT_ROLES = Object.freeze({
  document: new Set(["application/pdf", "text/plain", "text/markdown"]),
  image: new Set(["image/png", "image/jpeg", "image/webp"]),
  video: new Set(["video/mp4"]),
  audio: new Set(["audio/wav"]),
  transcript: new Set(["text/vtt", "text/plain", "text/markdown", "application/x-subrip", "text/x-ass"]),
  data: new Set(["text/csv", "application/json"]),
  code: new Set(["text/plain", "text/markdown", "text/javascript", "text/x-python", "text/x-diff", "application/json", "application/zip"]),
});

function fail(status, code, message, details) {
  throw new ApiError(status, code, message, details);
}

function jobId() {
  return `CDJ-${randomBytes(10).toString("hex")}`;
}

function stepId() {
  return `CDS-${randomBytes(10).toString("hex")}`;
}

function requestId() {
  return `CDR-${randomBytes(10).toString("hex")}`;
}

function batchId() {
  return `CDB-${randomBytes(10).toString("hex")}`;
}

function assertionAdmin(ctx) {
  if (!ctx || !ADMIN_METHODS.has(ctx.method)) fail(403, "AGENT_SCOPE_DENIED", "内容总控仅允许管理员操作。");
  const actor = String(ctx.actor ?? "").trim();
  if (!actor || actor.length > 120) fail(403, "AGENT_SCOPE_DENIED", "管理员身份无效。");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(ctx.idempotencyKey ?? "")) {
    fail(400, "IDEMPOTENCY_KEY_REQUIRED", "写入需要 8–128 位 Idempotency-Key。");
  }
  return actor;
}

function boundedText(value, name, maximum = 20_000, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return "";
  if (typeof value !== "string" || value.length > maximum || (!optional && !value.trim())) {
    fail(400, "CONTENT_DIRECTOR_INPUT_INVALID", `${name} 无效或超限。`);
  }
  return value.trim();
}

function stringList(value, name, maximum = 100) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) fail(400, "CONTENT_DIRECTOR_INPUT_INVALID", `${name} 必须是有界数组。`);
  return [...new Set(value.map(item => boundedText(String(item), name, 2000)))];
}

function claimRows(state, ids) {
  const rows = ids.map(id => state.claims.find(claim => claim.id === id));
  if (rows.some(row => !row)) fail(404, "CLAIM_NOT_FOUND", "内容任务引用了不存在的 Claim。");
  if (rows.some(row => row.state !== "approved")) fail(422, "CLAIM_NOT_APPROVED", "内容任务只能使用已批准 Claim。");
  return rows;
}

function normalizeFindings(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) fail(502, "AUDIT_FINDING_INVALID", "审核 finding 无效。");
    const severity = row.severity;
    if (!["blocker", "major", "minor", "suggestion"].includes(severity)) fail(502, "AUDIT_FINDING_INVALID", "审核 finding 级别无效。");
    const dimension = row.dimension;
    if (!["facts", "structure", "expression", "policy", "technical", "disclosure"].includes(dimension)) {
      fail(502, "AUDIT_FINDING_INVALID", "审核 finding 维度无效。");
    }
    return {
      id: `F-${String(index + 1).padStart(3, "0")}`,
      severity,
      dimension,
      code: boundedText(String(row.code ?? "REVIEW_FINDING"), "审核 finding code", 120),
      location: boundedText(String(row.location ?? "document"), "审核 finding location", 500),
      message: boundedText(String(row.message ?? ""), "审核 finding message", 5000),
      allowedChanges: Array.isArray(row.allowedChanges) ? row.allowedChanges.slice(0, 20).map(item => String(item).slice(0, 500)) : [],
      status: "open",
    };
  });
}

function articleHash(article) {
  return hashObject({
    title: article.title,
    summary: article.summary,
    body: article.body,
    sections: article.sections,
    visualSpecRefs: article.visualSpecRefs ?? [],
  });
}

function bytesHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateResearchPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Array.isArray(value.questions) || value.questions.length > 8 ||
      !Array.isArray(value.sourceNeeds) || !Array.isArray(value.gaps)) {
    fail(502, "RESEARCH_PLAN_INVALID", "研究计划结构无效。");
  }
  return {
    questions: value.questions.map((row, index) => ({
      id: `RQ-${String(index + 1).padStart(2, "0")}`,
      question: boundedText(String(row?.question ?? ""), "研究问题", 2000),
      purpose: boundedText(String(row?.purpose ?? ""), "研究目的", 2000),
    })),
    sourceNeeds: value.sourceNeeds.slice(0, 30).map(item => String(item).slice(0, 2000)),
    gaps: value.gaps.slice(0, 30).map(item => String(item).slice(0, 2000)),
  };
}

function assertJobVersion(job, ifMatch) {
  const expected = job?.etag ?? contentDirectorEtag(job);
  if (!ifMatch) fail(428, "PRECONDITION_REQUIRED", "修改内容 Job 需要准确 If-Match。");
  if (ifMatch !== expected) fail(412, "PRECONDITION_FAILED", "内容 Job 已变化，请刷新后重试。", { etag: expected });
}

function safeAttachmentName(value) {
  const name = boundedText(value ?? "attachment", "附件名称", 180);
  if (/[\\/\u0000-\u001f]/u.test(name) || name === "." || name === "..") {
    fail(400, "CONTENT_ATTACHMENT_NAME_INVALID", "附件名称不能包含路径或控制字符。");
  }
  return name;
}

function attachmentFingerprint(row) {
  return hashObject({
    id: row.id,
    kind: row.kind,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    name: row.name,
  });
}

function stableVisualId(jobIdValue, index, specHash) {
  return `VIS-${hashObject({ jobId: jobIdValue, index, specHash }).slice(0, 20)}`;
}

function upsertMissing(values) {
  return [...new Set(values.filter(Boolean))];
}

function sourcesForSection(sources, section, maximum = 8) {
  const words = new Set(`${section.title} ${section.purpose}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(value => value.length >= 2));
  return [...sources]
    .map((source, index) => {
      const text = `${source.title} ${source.snippet}`.toLowerCase();
      const score = [...words].reduce((total, word) => total + (text.includes(word) ? 1 : 0), 0);
      return { source, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maximum)
    .map(row => row.source);
}

function normalizeJobInput(route, input, claimIds) {
  const exactAttachments = new Map((input.attachments ?? []).map(row => [row.id, row]));
  return {
    intent: route.intent,
    explicitKind: route.artifactKind,
    attachments: route.attachments.map(row => ({
      ...row,
      ...(exactAttachments.get(row.id) ? {
        mime: exactAttachments.get(row.id).mime ?? row.mime,
        name: exactAttachments.get(row.id).name ?? row.name,
        size: exactAttachments.get(row.id).size,
        sha256: exactAttachments.get(row.id).sha256,
      } : {}),
    })),
    platforms: route.platforms,
    allowWebResearch: route.allowWebResearch,
    enableVisuals: route.enableVisuals,
    targetLength: route.targetLength,
    durationSec: route.durationSec,
    shotPlan: route.shotPlan,
    videoRightsConfirmed: route.videoRightsConfirmed === true,
    videoRightsNote: boundedText(input.videoRightsNote ?? "", "videoRightsNote", 2000, { optional: true }),
    claimIds,
    authorThoughts: stringList(input.authorThoughts, "authorThoughts", 100),
    audience: boundedText(input.audience ?? "", "audience", 1000, { optional: true }),
    goal: boundedText(input.goal ?? "", "goal", 4000, { optional: true }),
    language: input.language === "en-US" ? "en-US" : "zh-CN",
    mustKeep: stringList(input.mustKeep, "mustKeep", 100),
    mustAvoid: stringList(input.mustAvoid, "mustAvoid", 100),
  };
}

export class ContentDirectorService {
  #running = new Set();
  #scheduled = new Set();
  #draining = null;
  #schedulerError = null;
  #artifactRoot;
  #artifactRootReal = null;
  #attachmentRootReal = null;

  constructor({
    store,
    model,
    editorial = null,
    mediaAssets = null,
    contentOps = null,
    videoRuntime = null,
    artifactRoot,
    clock = () => new Date(),
    autoStart = true,
    mode = "enabled",
  } = {}) {
    if (!store) throw new Error("ContentDirectorService requires a store.");
    this.store = store;
    this.model = model;
    this.editorial = editorial;
    this.mediaAssets = mediaAssets;
    this.contentOps = contentOps;
    this.videoRuntime = videoRuntime;
    this.clock = clock;
    this.autoStart = autoStart !== false;
    if (!["enabled", "shadow", "disabled"].includes(mode)) throw new Error("CONTENT_DIRECTOR_MODE_INVALID");
    this.mode = mode;
    this.enabled = mode !== "disabled";
    this.#artifactRoot = resolve(artifactRoot ?? join(dirname(store.filePath), "content-director"));
  }

  getStatus() {
    return {
      schema: "pengmanager.content-director-status/v1",
      enabled: this.enabled,
      mode: this.mode,
      writable: this.mode === "enabled",
      autoStart: this.autoStart,
      runningJobs: this.#running.size,
      maxConcurrentJobs: MAX_JOBS_RUNNING,
    };
  }

  state() {
    if (!this.enabled) fail(503, "CONTENT_DIRECTOR_DISABLED", "创作总控已由功能开关关闭；旧内容入口与数据仍保留。");
    if (this.#schedulerError) fail(503, "CONTENT_DIRECTOR_SCHEDULER_FAILED", "内容任务调度器出现未恢复错误，停止继续派发。", { cause: this.#schedulerError.code ?? "SCHEDULER_FAILED" });
    const state = this.store.snapshot();
    if (state.schemaVersion !== 4) fail(503, "CONTENT_DIRECTOR_MIGRATION_REQUIRED", "内容总控需要完成 v4 迁移。");
    assertContentDirectorStateIntegrity(state);
    return state;
  }

  async recover() {
    const state = this.state();
    const interrupted = state.contentDirectorJobs.filter(job => job.status === "running");
    if (!interrupted.length) return { recovered: 0 };
    const now = this.clock().toISOString();
    await this.store.mutate({
      type: "content_director.recovered",
      actor: "system",
      payload: { jobIds: interrupted.map(job => job.id) },
    }, next => {
      for (const job of next.contentDirectorJobs.filter(row => row.status === "running")) {
        job.status = "needs_resume";
        job.recoveredAt = now;
        job.revision += 1;
        job.updatedAt = now;
      }
      for (const step of next.contentDirectorSteps.filter(row => row.status === "running")) {
        step.status = "failed";
        step.error = { code: "PROCESS_INTERRUPTED", message: "进程中断；恢复时按原任务重新读取。" };
        step.finishedAt = now;
        step.updatedAt = now;
      }
      return { recovered: interrupted.length };
    });
    return { recovered: interrupted.length };
  }

  listAttachments() {
    this.state();
    return {
      items: this.state().contentDirectorAttachments.map(row => structuredClone(row)),
      roles: Object.fromEntries(Object.entries(ATTACHMENT_ROLES).map(([role, mimes]) => [role, [...mimes]])),
      maxAttachmentBytes: 50 * 1024 * 1024,
    };
  }

  async uploadAttachment(readable, metadata, ctx) {
    const previous = attachmentQueues.get(this.store) ?? Promise.resolve();
    const run = previous.then(() => this.#uploadAttachmentOnce(readable, metadata, ctx));
    attachmentQueues.set(this.store, run.catch(() => undefined));
    return run;
  }

  async #uploadAttachmentOnce(readable, metadata, ctx) {
    const actor = assertionAdmin(ctx);
    if (this.mode !== "enabled") fail(409, "CONTENT_DIRECTOR_READ_ONLY", "当前功能处于 shadow 或 disabled 模式，不能写入附件。");
    if (!readable?.[Symbol.asyncIterator]) fail(400, "CONTENT_ATTACHMENT_BODY_REQUIRED", "上传正文必须是二进制流。");
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) fail(400, "CONTENT_ATTACHMENT_INVALID", "附件元数据无效。");
    const role = String(metadata.role ?? "").trim();
    if (!Object.hasOwn(ATTACHMENT_ROLES, role)) fail(400, "CONTENT_ATTACHMENT_ROLE_INVALID", "附件用途不受支持。");
    const mime = String(metadata.mime ?? "").split(";", 1)[0].trim().toLowerCase();
    if (!ATTACHMENT_ROLES[role].has(mime)) fail(415, "CONTENT_ATTACHMENT_TYPE_INVALID", "附件用途与 MIME 类型不匹配。");
    const size = Number(metadata.size);
    if (!Number.isSafeInteger(size) || size < 1 || size > 50 * 1024 * 1024) fail(413, "CONTENT_ATTACHMENT_SIZE_INVALID", "附件大小必须是 1 字节到 50 MiB。");
    if (!SHA256.test(metadata.sha256 ?? "")) fail(400, "CONTENT_ATTACHMENT_HASH_INVALID", "附件需要准确 SHA-256。");
    const name = safeAttachmentName(metadata.name);
    const speechLikely = metadata.speechLikely === true;
    const durationSec = metadata.durationSec === undefined || metadata.durationSec === null ? null : Number(metadata.durationSec);
    if (durationSec !== null && (!Number.isSafeInteger(durationSec) || durationSec < 0 || durationSec > 86_400)) {
      fail(400, "CONTENT_ATTACHMENT_DURATION_INVALID", "附件时长无效。");
    }
    const request = { role, mime, size, sha256: metadata.sha256, name, speechLikely, durationSec };
    const requestHash = hashObject(request);
    const keyHash = hashObject({ actor, scope: "attachment.upload", key: ctx.idempotencyKey });
    const state = this.state();
    const prior = state.contentDirectorRequests.find(row => row.keyHash === keyHash);
    if (prior) {
      if (prior.requestHash !== requestHash) fail(409, "IDEMPOTENCY_CONFLICT", "幂等键已用于不同附件上传。");
      readable.resume?.();
      return structuredClone(prior.result);
    }
    const id = `CDU-${hashObject({ actor, key: ctx.idempotencyKey }).slice(0, 32)}`;
    const root = await this.#ensureAttachmentRoot();
    const directory = join(root, "objects");
    const staging = join(root, "staging");
    const finalPath = join(directory, `${id}.bin`);
    const temporary = join(staging, `${randomBytes(16).toString("hex")}.upload`);
    let handle;
    let temporaryOwned = false;
    let finalOwned = false;
    try {
      handle = await open(temporary, "wx", 0o600);
      temporaryOwned = true;
      const digest = createHash("sha256");
      let actual = 0;
      for await (const chunk of readable) {
        if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) fail(400, "CONTENT_ATTACHMENT_BODY_INVALID", "附件正文必须为二进制。");
        const bytes = Buffer.from(chunk);
        actual += bytes.length;
        if (actual > size) fail(413, "CONTENT_ATTACHMENT_TOO_LARGE", "附件正文超过预声明大小。");
        digest.update(bytes);
        await handle.writeFile(bytes);
      }
      if (actual !== size) fail(400, "CONTENT_ATTACHMENT_SIZE_MISMATCH", "附件正文长度与预声明不一致。");
      if (digest.digest("hex") !== request.sha256) fail(400, "CONTENT_ATTACHMENT_HASH_MISMATCH", "附件实际摘要与预声明不一致。");
      await handle.sync();
      await handle.close();
      handle = null;
      const bytes = await readFile(temporary);
      const inspection = inspectProductionArtifact(bytes, mime);
      let characters = null;
      if (["text/plain", "text/markdown", "text/csv", "text/javascript", "text/x-python", "application/json"].includes(mime)) {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        characters = text.replace(/\s+/g, "").length;
      }
      try {
        await link(temporary, finalPath);
        finalOwned = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = await readFile(finalPath);
        if (bytesHash(existing) !== request.sha256 || existing.length !== size) {
          fail(409, "CONTENT_ATTACHMENT_RECOVERY_CONFLICT", "同一上传键已有不同附件，原文件已保留。");
        }
      }
      const row = {
        schema: "pengmanager.content-director-attachment/v1",
        id,
        role,
        kind: role === "transcript" && mime === "text/vtt" ? "transcript" : role,
        mime,
        name,
        size,
        bytes: size,
        sha256: request.sha256,
        speechLikely,
        durationSec,
        characters,
        inspection,
        status: "stored",
        receiptHash: attachmentFingerprint({
          id, kind: role, mime, size, sha256: request.sha256, name,
        }),
        createdBy: actor,
        createdAt: this.clock().toISOString(),
      };
      return await this.#write("attachment.upload", request, ctx, next => {
        const previous = next.contentDirectorRequests.find(item => item.keyHash === keyHash);
        if (previous) return JsonStore.noChange(previous.result);
        next.contentDirectorAttachments.push(row);
        return { ...structuredClone(row), etag: contentDirectorEtag(row) };
      });
    } catch (error) {
      if (finalOwned) await unlink(finalPath).catch(() => undefined);
      if (error instanceof ApiError) throw error;
      if (readable.aborted || ["ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE"].includes(error.code)) {
        throw new ApiError(400, "CONTENT_ATTACHMENT_UPLOAD_INTERRUPTED", "附件上传中断；请使用同一幂等键重试。");
      }
      throw new ApiError(503, "CONTENT_ATTACHMENT_STORAGE_UNAVAILABLE", "附件暂存失败，请使用同一幂等键重试。");
    } finally {
      await handle?.close();
      if (temporaryOwned) await unlink(temporary).catch(() => undefined);
    }
  }

  async readAttachment(id) {
    const row = this.state().contentDirectorAttachments.find(item => item.id === id);
    if (!ATTACHMENT_ID.test(id ?? "") || !row) fail(404, "CONTENT_ATTACHMENT_NOT_FOUND", "找不到内容附件。");
    const root = await this.#ensureAttachmentRoot();
    const file = join(root, "objects", `${row.id}.bin`);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== row.size) fail(409, "CONTENT_ATTACHMENT_CHANGED", "附件字节发生变化。");
    const bytes = await readFile(file);
    if (bytesHash(bytes) !== row.sha256) fail(409, "CONTENT_ATTACHMENT_CHANGED", "附件摘要发生变化。");
    return { ...structuredClone(row), bytes };
  }

  async resolveIntent(input = {}) {
    const state = this.state();
    const initialInput = {
      ...input,
      attachments: this.#resolveAttachmentInput(input.attachments, state, { allowPartial: true }),
    };
    const initial = resolveContentIntent(initialInput);
    if (initial.artifactKind || !this.model || input.useModel === false) return initial;
    try {
      const classified = await this.model.classifyAmbiguous({
        intent: input.intent,
        explicitKind: input.explicitKind ?? null,
        attachments: initial.attachments,
        platforms: initial.platforms,
      });
      return resolveContentIntent({ ...initialInput, modelDecision: classified.value });
    } catch (error) {
      return { ...initial, modelError: error?.code ?? "CONTENT_ROUTE_MODEL_UNAVAILABLE" };
    }
  }

  async createJob(input, ctx, { internalBatchId = null } = {}) {
    const actor = assertionAdmin(ctx);
    if (this.mode !== "enabled") fail(409, "CONTENT_DIRECTOR_READ_ONLY", "当前功能处于 shadow 或 disabled 模式，只允许路由观测。");
    if (!input || typeof input !== "object" || Array.isArray(input)) fail(400, "CONTENT_DIRECTOR_INPUT_INVALID", "任务输入必须是对象。");
    const state = this.state();
    const attachments = this.#resolveAttachmentInput(input.attachments, state);
    const route = await this.resolveIntent({ ...input, attachments });
    if (!route.artifactKind) fail(422, "CONTENT_INTENT_CLARIFICATION_REQUIRED", route.clarifyQuestion ?? "需要明确内容类型。", { route });
    const claimIds = stringList(input.claimIds, "claimIds", 100);
    claimRows(state, claimIds);
    const normalized = normalizeJobInput(route, { ...input, attachments }, claimIds);
    const attachmentBindings = this.#attachmentBindings(normalized.attachments, state);
    const outcome = await this.#write("job_created", input, ctx, (next, { actor: writeActor, now, payload }) => {
      for (const id of claimIds) {
        const claim = next.claims.find(row => row.id === id);
        if (!claim || claim.state !== "approved") fail(409, "CLAIM_CHANGED", "创建任务期间 Claim 状态已变化。");
      }
      this.#assertAttachmentBindings(attachmentBindings, next);
      const id = jobId();
      const at = now.toISOString();
      const routeStep = {
        id: stepId(),
        schema: "pengmanager.content-director-step/v1",
        jobId: id,
        kind: "route.resolve",
        key: "route",
        status: "succeeded",
        inputHash: hashObject(input),
        output: {
          routeHash: route.routeHash,
          artifactKind: route.artifactKind,
          pipeline: route.pipeline,
          confidence: route.confidence,
          rationale: route.rationale,
          missing: route.missing,
        },
        startedAt: at,
        finishedAt: at,
        createdAt: at,
        updatedAt: at,
      };
      next.contentDirectorSteps.push(routeStep);
      let attachmentStep = null;
      if (normalized.attachments.length) {
        attachmentStep = {
          id: stepId(),
          schema: "pengmanager.content-director-step/v1",
          jobId: id,
          kind: "attachment.ingest",
          key: "attachments",
          status: "succeeded",
          inputHash: hashObject(attachmentBindings),
          output: { attachmentCount: normalized.attachments.length, receipts: attachmentBindings },
          startedAt: at,
          finishedAt: at,
          createdAt: at,
          updatedAt: at,
        };
        next.contentDirectorSteps.push(attachmentStep);
      }
      const job = {
        id,
        schema: "pengmanager.content-director-job/v1",
        batchId: internalBatchId,
        artifactKind: route.artifactKind,
        pipeline: route.pipeline,
        route,
        input: normalized,
        status: route.missing.length ? "needs_input" : "queued",
        revision: 1,
        stepRefs: [routeStep.id, ...(attachmentStep ? [attachmentStep.id] : [])],
        currentStep: "route.resolve",
        missing: upsertMissing(route.missing),
        artifacts: [],
        visualSpecIds: [],
        findings: [],
        review: null,
        resultRef: null,
        resultHash: null,
        error: null,
        createdBy: writeActor,
        createdAt: at,
        updatedAt: at,
      };
      next.contentDirectorJobs.push(job);
      payload.jobId = id;
      payload.pipeline = job.pipeline;
      return contentDirectorEntity(job);
    });
    return outcome;
  }

  async createBatch(input, ctx) {
    const actor = assertionAdmin(ctx);
    if (this.mode !== "enabled") fail(409, "CONTENT_DIRECTOR_READ_ONLY", "当前功能处于 shadow 或 disabled 模式，只允许路由观测。");
    const topics = Array.isArray(input?.topics) ? input.topics : [];
    if (!topics.length || topics.length > 20) fail(400, "CONTENT_BATCH_INVALID", "批次必须包含 1–20 个主题。");
    if (!input?.shared || typeof input.shared !== "object" || Array.isArray(input.shared)) {
      fail(400, "CONTENT_BATCH_INVALID", "批次需要共享简报对象。");
    }
    const prepared = [];
    for (const [index, topic] of topics.entries()) {
      const row = typeof topic === "string" ? { intent: topic } : topic;
      if (!row || typeof row !== "object" || Array.isArray(row)) fail(400, "CONTENT_BATCH_INVALID", `第 ${index + 1} 个主题无效。`);
      const merged = { ...input.shared, ...row };
      const state = this.state();
      const attachments = this.#resolveAttachmentInput(merged.attachments, state);
      const route = await this.resolveIntent({ ...merged, attachments });
      if (!route.artifactKind) {
        fail(422, "CONTENT_BATCH_ROUTE_REQUIRED", `第 ${index + 1} 个主题无法确定内容类型。`, { index, route });
      }
      const claimIds = stringList(merged.claimIds, "claimIds", 100);
      claimRows(state, claimIds);
      const normalized = normalizeJobInput(route, merged, claimIds);
      prepared.push({
        route,
        input: merged,
        normalized,
        claimIds,
        attachmentBindings: this.#attachmentBindings(normalized.attachments, state),
      });
    }
    const result = await this.#write("batch_created", input, ctx, (state, { actor: writeActor, now }) => {
      for (const row of prepared) {
        for (const id of row.claimIds) {
          if (state.claims.find(claim => claim.id === id)?.state !== "approved") fail(409, "CLAIM_CHANGED", "批次建立期间 Claim 状态已变化。");
        }
        this.#assertAttachmentBindings(row.attachmentBindings, state);
      }
      const id = batchId();
      const at = now.toISOString();
      const jobs = prepared.map(row => {
        const jobIdValue = jobId();
        const routeStep = {
          id: stepId(),
          schema: "pengmanager.content-director-step/v1",
          jobId: jobIdValue,
          kind: "route.resolve",
          key: "route",
          status: "succeeded",
          inputHash: hashObject(row.input),
          output: {
            routeHash: row.route.routeHash,
            artifactKind: row.route.artifactKind,
            pipeline: row.route.pipeline,
            confidence: row.route.confidence,
            rationale: row.route.rationale,
            missing: row.route.missing,
          },
          startedAt: at,
          finishedAt: at,
          createdAt: at,
          updatedAt: at,
        };
        state.contentDirectorSteps.push(routeStep);
        const job = {
          id: jobIdValue,
          schema: "pengmanager.content-director-job/v1",
          batchId: id,
          artifactKind: row.route.artifactKind,
          pipeline: row.route.pipeline,
          route: row.route,
          input: row.normalized,
          status: row.route.missing.length ? "needs_input" : "queued",
          revision: 1,
          stepRefs: [routeStep.id],
          currentStep: "route.resolve",
          missing: upsertMissing(row.route.missing),
          artifacts: [],
          visualSpecIds: [],
          findings: [],
          review: null,
          resultRef: null,
          resultHash: null,
          error: null,
          pauseRequested: false,
          createdBy: writeActor,
          createdAt: at,
          updatedAt: at,
        };
        state.contentDirectorJobs.push(job);
        return job;
      });
      const batch = {
        id,
        schema: "pengmanager.content-batch/v1",
        name: boundedText(input.name ?? "未命名内容批次", "批次名称", 240),
        jobIds: jobs.map(job => job.id),
        status: jobs.some(job => job.status === "needs_input") ? "needs_input" : "queued",
        pauseRequested: false,
        createdBy: writeActor,
        createdAt: at,
        updatedAt: at,
      };
      state.contentBatches.push(batch);
      return {
        ...batch,
        etag: contentDirectorEtag(batch),
        jobs: jobs.map(job => contentDirectorEntity(job)),
      };
    });
    if (this.autoStart) {
      for (const job of result.jobs) if (!job.missing?.length) this.#schedule(job.id);
    }
    return result;
  }

  listJobs() {
    const state = this.state();
    return {
      items: [...state.contentDirectorJobs]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(job => ({
          ...contentDirectorEntity(job),
          steps: state.contentDirectorSteps.filter(step => step.jobId === job.id),
        })),
    };
  }

  listBatches() {
    const state = this.state();
    return {
      items: state.contentBatches.map(batch => ({
        ...batch,
        etag: contentDirectorEtag(batch),
        counts: Object.fromEntries(CONTENT_DIRECTOR_STATUSES
          .map(status => [status, batch.jobIds.filter(id => state.contentDirectorJobs.find(job => job.id === id)?.status === status).length])),
      })),
    };
  }

  getMetrics() {
    const state = this.state();
    const jobs = state.contentDirectorJobs;
    const finalized = jobs.filter(job => ["needs_review", "approved", "blocked", "completed"].includes(job.status));
    const firstPass = finalized.filter(job => !(job.findings ?? []).some(finding => ["blocker", "major"].includes(finding.severity)));
    const visualRows = state.visualSpecs;
    return {
      schema: "pengmanager.content-director-metrics/v1",
      generatedAt: this.clock().toISOString(),
      jobs: {
        total: jobs.length,
        byStatus: Object.fromEntries(CONTENT_DIRECTOR_STATUSES.map(value => [value, jobs.filter(job => job.status === value).length])),
        byArtifactKind: Object.fromEntries(CONTENT_ARTIFACT_KINDS.map(value => [value, jobs.filter(job => job.artifactKind === value).length])),
      },
      routing: {
        averageConfidence: jobs.length ? Number((jobs.reduce((total, job) => total + Number(job.route?.confidence ?? 0), 0) / jobs.length).toFixed(4)) : null,
        modelFallbackCount: jobs.filter(job => job.route?.rationale?.includes("模型")).length,
      },
      article: {
        finalizedCount: finalized.filter(job => ["article", "article_visual"].includes(job.artifactKind)).length,
        firstPassQualityRate: finalized.length ? Number((firstPass.length / finalized.length).toFixed(4)) : null,
        averageRepairAttempts: finalized.length
          ? Number((state.contentRepairAttempts.length / Math.max(1, finalized.filter(job => ["article", "article_visual"].includes(job.artifactKind)).length)).toFixed(2))
          : 0,
        openBlockers: jobs.reduce((total, job) => total + (job.findings ?? []).filter(finding => finding.status === "open" && finding.severity === "blocker").length, 0),
        openMajors: jobs.reduce((total, job) => total + (job.findings ?? []).filter(finding => finding.status === "open" && finding.severity === "major").length, 0),
      },
      visual: {
        total: visualRows.length,
        active: jobs.reduce((total, job) => total + (job.visualSpecIds?.length ?? 0), 0),
        pngSuccessRate: visualRows.length
          ? Number((visualRows.filter(row => row.artifacts?.some(artifact => artifact.mime === "image/png")).length / visualRows.length).toFixed(4))
          : null,
      },
      evidence: {
        researchSources: state.contentResearchBundles.reduce((total, bundle) => total + (bundle.sources?.length ?? 0), 0),
        auditReports: state.contentAuditReports.length,
        repairAttempts: state.contentRepairAttempts.length,
        publishPackages: state.contentPublishPackages.length,
      },
    };
  }

  getBatch(id) {
    const state = this.state();
    const batch = state.contentBatches.find(row => row.id === id);
    if (!batch) fail(404, "CONTENT_BATCH_NOT_FOUND", "找不到内容批次。");
    return {
      ...batch,
      etag: contentDirectorEtag(batch),
      counts: Object.fromEntries(CONTENT_DIRECTOR_STATUSES
        .map(status => [status, batch.jobIds.filter(jobId => state.contentDirectorJobs.find(job => job.id === jobId)?.status === status).length])),
      jobs: batch.jobIds.map(jobId => contentDirectorEntity(state.contentDirectorJobs.find(job => job.id === jobId))),
    };
  }

  async controlBatch(id, input, ctx) {
    assertionAdmin(ctx);
    const action = input?.action;
    if (!["pause", "resume", "cancel"].includes(action)) fail(400, "CONTENT_BATCH_ACTION_INVALID", "批次操作必须是 pause、resume 或 cancel。");
    const result = await this.#write(`batch_control:${id}:${action}`, input, ctx, (state, { actor, now }) => {
      const batch = state.contentBatches.find(row => row.id === id);
      if (!batch) fail(404, "CONTENT_BATCH_NOT_FOUND", "找不到内容批次。");
      if (!ctx.ifMatch) fail(428, "PRECONDITION_REQUIRED", "批次操作需要准确 If-Match。");
      if (ctx.ifMatch !== contentDirectorEtag(batch)) fail(412, "PRECONDITION_FAILED", "批次已变化，请刷新后重试。", { etag: contentDirectorEtag(batch) });
      const at = now.toISOString();
      const jobs = batch.jobIds.map(jobId => state.contentDirectorJobs.find(row => row.id === jobId)).filter(Boolean);
      for (const job of jobs) {
        if (TERMINAL.has(job.status) && action !== "cancel") continue;
        if (action === "pause") {
          if (!["queued", "running", "needs_resume"].includes(job.status)) continue;
          job.pauseRequested = true;
          if (!this.#running.has(job.id)) job.status = "needs_resume";
        } else if (action === "resume") {
          if (job.status !== "needs_resume") continue;
          job.pauseRequested = false;
          job.status = "queued";
        } else {
          if (TERMINAL.has(job.status) && job.status !== "failed") continue;
          job.pauseRequested = false;
          job.status = "cancelled";
          job.cancelledAt = at;
        }
        job.revision += 1;
        job.updatedAt = at;
      }
      batch.pauseRequested = action === "pause";
      batch.status = action === "pause" ? "needs_resume" : action === "cancel" ? "cancelled" : "queued";
      batch.updatedAt = at;
      batch.revision = (batch.revision ?? 1) + 1;
      return {
        ...structuredClone(batch),
        etag: contentDirectorEtag(batch),
        counts: Object.fromEntries(CONTENT_DIRECTOR_STATUSES
          .map(status => [status, jobs.filter(job => job.status === status).length])),
        jobs: jobs.map(job => contentDirectorEntity(job)),
      };
    });
    if (action === "resume" && this.autoStart) {
      for (const job of result.jobs) if (job.status === "queued" && !job.missing?.length) this.#schedule(job.id);
    }
    return result;
  }

  async getJob(id) {
    const state = this.state();
    const job = state.contentDirectorJobs.find(row => row.id === id);
    if (!job) fail(404, "CONTENT_JOB_NOT_FOUND", "找不到内容 Job。");
    let result = null;
    if (job.resultRef) {
      try { result = JSON.parse((await this.readArtifact(id, job.resultRef.name)).bytes.toString("utf8")); }
      catch (error) {
        fail(503, "CONTENT_RESULT_UNAVAILABLE", "已冻结内容结果无法读取；不会把它当作空结果继续。", { cause: error?.code ?? "CONTENT_RESULT_READ_FAILED" });
      }
    }
    return {
      ...contentDirectorEntity(job),
      steps: state.contentDirectorSteps.filter(step => step.jobId === id),
      visualSpecs: (job.visualSpecIds ?? []).map(visualId => state.visualSpecs.find(spec => spec.id === visualId && spec.jobId === id)).filter(Boolean),
      reports: state.contentAuditReports.filter(report => report.jobId === id).sort((a, b) => b.generatedAt.localeCompare(a.generatedAt)),
      result,
    };
  }

  getSteps(id) {
    const state = this.state();
    const job = state.contentDirectorJobs.find(row => row.id === id);
    if (!job) fail(404, "CONTENT_JOB_NOT_FOUND", "找不到内容 Job。");
    return { items: job.stepRefs.map(stepId => state.contentDirectorSteps.find(step => step.id === stepId)).filter(Boolean) };
  }

  async getJobContext(id) {
    const job = await this.getJob(id);
    const state = this.state();
    let contentOps = null;
    if (this.contentOps) {
      try {
        const bootstrap = this.contentOps.bootstrap({ method: "local", actor: "content-director-context" });
        contentOps = {
          destinations: bootstrap.destinations,
          accounts: bootstrap.accounts,
          budgets: bootstrap.budgets,
          profiles: bootstrap.profiles,
          stories: bootstrap.stories,
          editions: bootstrap.editions,
        };
      } catch (error) {
        contentOps = { unavailable: true, code: error?.code ?? "CONTENT_OPS_CONTEXT_UNAVAILABLE" };
      }
    }
    return {
      schema: "pengmanager.content-director-context/v1",
      job,
      claims: state.claims,
      attachments: state.contentDirectorAttachments,
      contentOps,
    };
  }

  async getFindings(id) {
    const job = await this.getJob(id);
    return {
      contentHash: job.result?.contentHash ?? null,
      resultHash: job.resultHash,
      items: job.findings ?? [],
      reports: job.reports,
    };
  }

  async patchBrief(id, input, ctx) {
    assertionAdmin(ctx);
    const current = await this.getJob(id);
    assertJobVersion(current, ctx.ifMatch);
    if (!["queued", "needs_input", "needs_resume", "blocked", "failed"].includes(current.status)) {
      fail(409, "CONTENT_BRIEF_NOT_EDITABLE", "当前 Job 已进入待审或终态，修改会改变已冻结结果；请新建 Job revision。");
    }
    const allowed = new Set(["audience", "goal", "language", "authorThoughts", "mustKeep", "mustAvoid", "targetLength", "allowWebResearch", "enableVisuals", "videoRightsConfirmed", "videoRightsNote", "shotPlan"]);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key))) {
      fail(400, "CONTENT_BRIEF_INVALID", "Brief 修改字段无效。");
    }
    const merged = { ...current.input, ...structuredClone(input), explicitKind: current.artifactKind };
    const route = await this.resolveIntent(merged);
    if (route.artifactKind !== current.artifactKind) {
      fail(409, "CONTENT_ROUTE_CHANGE_REQUIRES_NEW_JOB", "切换内容生产线必须创建新 Job，不能改写原执行记录。");
    }
    await this.#write(`brief_patched:${id}`, input, ctx, (state, { actor, now }) => {
      const job = state.contentDirectorJobs.find(row => row.id === id);
      assertJobVersion(job, ctx.ifMatch);
      job.input = normalizeJobInput(route, merged, job.input.claimIds);
      job.route = route;
      job.missing = upsertMissing(route.missing);
      job.status = job.missing.length ? "needs_input" : "queued";
      job.resultRef = null;
      job.resultHash = null;
      job.visualSpecIds = [];
      job.findings = [];
      job.review = null;
      job.error = null;
      job.pauseRequested = false;
      job.outlineRef = null;
      job.revision += 1;
      job.updatedAt = now.toISOString();
      return contentDirectorEntity(job);
    });
    return this.getJob(id);
  }

  async freezeOutline(id, input, ctx) {
    assertionAdmin(ctx);
    const current = await this.getJob(id);
    assertJobVersion(current, ctx.ifMatch);
    if (!["article", "article_visual"].includes(current.artifactKind)) fail(409, "CONTENT_OUTLINE_NOT_APPLICABLE", "只有文章生产线可以冻结提纲。");
    if (!["queued", "needs_input", "needs_resume", "blocked", "failed"].includes(current.status)) {
      fail(409, "CONTENT_OUTLINE_NOT_EDITABLE", "当前 Job 已进入待审或终态；请新建 Job revision。");
    }
    const brief = await this.#briefContext(current);
    const outline = validateOutline(input?.outline, brief);
    const artifact = await this.#writeArtifact(id, `outline-frozen-${hashObject(outline).slice(0, 12)}.json`, outline, "application/json");
    await this.#write(`outline_frozen:${id}`, { outline }, ctx, (state, { actor, now }) => {
      const job = state.contentDirectorJobs.find(row => row.id === id);
      assertJobVersion(job, ctx.ifMatch);
      const revision = {
        id: `CDV-${randomBytes(10).toString("hex")}`,
        schema: "pengmanager.content-director-revision/v1",
        jobId: id,
        kind: "outline",
        revision: state.contentDirectorRevisions.filter(row => row.jobId === id && row.kind === "outline").length + 1,
        hash: hashObject(outline),
        artifact,
        createdBy: actor,
        createdAt: now.toISOString(),
      };
      state.contentDirectorRevisions.push(revision);
      if (!job.artifacts.some(item => item.name === artifact.name && item.sha256 === artifact.sha256)) job.artifacts.push(artifact);
      job.outlineRef = { revisionId: revision.id, hash: revision.hash, artifact };
      job.missing = [];
      job.status = "queued";
      job.error = null;
      job.pauseRequested = false;
      job.resultRef = null;
      job.resultHash = null;
      job.visualSpecIds = [];
      job.findings = [];
      job.revision += 1;
      job.updatedAt = now.toISOString();
      return contentDirectorEntity(job);
    });
    if (input?.autoContinue === true && this.autoStart) this.#schedule(id);
    return this.getJob(id);
  }

  async startJob(id, ctx) {
    assertionAdmin(ctx);
    const job = await this.getJob(id);
    if (job.missing.length) fail(409, "CONTENT_JOB_NEEDS_INPUT", "任务仍缺少必要输入。", { missing: job.missing });
    if (!["queued", "needs_resume", "blocked", "failed"].includes(job.status)) {
      fail(409, "CONTENT_JOB_NOT_STARTABLE", `当前状态 ${job.status} 不能启动。`);
    }
    await this.store.mutate({
      type: "content_director.job_started",
      actor: ctx.actor,
      payload: { jobId: id },
    }, state => {
      const row = state.contentDirectorJobs.find(item => item.id === id);
      row.status = "queued";
      row.error = null;
      row.pauseRequested = false;
      row.revision += 1;
      row.updatedAt = this.clock().toISOString();
      return row;
    });
    if (this.autoStart) this.#schedule(id);
    return this.getJob(id);
  }

  async processJob(id) {
    if (this.#running.has(id)) fail(409, "CONTENT_JOB_BUSY", "此内容 Job 已在执行。");
    if (this.#running.size >= MAX_JOBS_RUNNING) {
      return this.getJob(id);
    }
    const state = this.state();
    const job = state.contentDirectorJobs.find(row => row.id === id);
    if (!job) fail(404, "CONTENT_JOB_NOT_FOUND", "找不到内容 Job。");
    if (!["queued", "needs_resume", "running"].includes(job.status)) return this.getJob(id);
    this.#running.add(id);
    try {
      if (job.status !== "running") {
        await this.store.mutate({
          type: "content_director.job_running",
          actor: "content-director-worker",
          payload: { jobId: id },
        }, state => {
          const row = state.contentDirectorJobs.find(item => item.id === id);
          row.status = "running";
          row.revision += 1;
          row.updatedAt = this.clock().toISOString();
          return row;
        });
      }
      return await this.#executeJob(id);
    } finally {
      this.#running.delete(id);
      this.#scheduleDrain();
    }
  }

  async #executeJob(id) {
    try {
      const job = this.state().contentDirectorJobs.find(row => row.id === id);
      if (!job) fail(404, "CONTENT_JOB_NOT_FOUND", "找不到内容 Job。");
      if (!["running", "queued", "needs_resume"].includes(job.status)) return this.getJob(id);
      await this.#assertLive(id);
      if (job.artifactKind === "article" || job.artifactKind === "article_visual") {
        await this.#processArticle(id);
      } else if (job.artifactKind === "pure_visual") {
        await this.#processPureVisual(id);
      } else {
        await this.#processVideo(id);
      }
      return this.getJob(id);
    } catch (error) {
      await this.#markJobFailure(id, error);
      throw error;
    }
  }

  async pauseJob(id, ctx) {
    assertionAdmin(ctx);
    const current = await this.getJob(id);
    assertJobVersion(current, ctx.ifMatch);
    await this.store.mutate({ type: "content_director.job_pause_requested", actor: ctx.actor, payload: { jobId: id } }, state => {
      const job = state.contentDirectorJobs.find(row => row.id === id);
      if (!job) fail(404, "CONTENT_JOB_NOT_FOUND", "找不到内容 Job。");
      if (!["queued", "running", "needs_resume"].includes(job.status)) fail(409, "CONTENT_JOB_NOT_PAUSABLE", "当前任务不能暂停。");
      assertJobVersion(job, ctx.ifMatch);
      job.pauseRequested = true;
      if (!this.#running.has(id)) job.status = "needs_resume";
      job.revision += 1;
      job.updatedAt = this.clock().toISOString();
      return job;
    });
    return this.getJob(id);
  }

  async resumeJob(id, ctx) {
    assertionAdmin(ctx);
    const job = await this.getJob(id);
    assertJobVersion(job, ctx.ifMatch);
    if (!["needs_resume", "running"].includes(job.status) || job.pauseRequested !== true) {
      fail(409, "CONTENT_JOB_NOT_PAUSED", "只有已请求暂停的 Job 可以从暂停状态恢复。");
    }
    await this.store.mutate({ type: "content_director.job_resume_requested", actor: ctx.actor, payload: { jobId: id } }, state => {
      const row = state.contentDirectorJobs.find(item => item.id === id);
      assertJobVersion(row, ctx.ifMatch);
      row.pauseRequested = false;
      row.status = "queued";
      row.revision += 1;
      row.updatedAt = this.clock().toISOString();
      return row;
    });
    if (this.autoStart) this.#schedule(id);
    return this.getJob(id);
  }

  async cancelJob(id, ctx) {
    assertionAdmin(ctx);
    const current = await this.getJob(id);
    assertJobVersion(current, ctx.ifMatch);
    await this.store.mutate({ type: "content_director.job_cancelled", actor: ctx.actor, payload: { jobId: id } }, state => {
      const job = state.contentDirectorJobs.find(row => row.id === id);
      if (!job) fail(404, "CONTENT_JOB_NOT_FOUND", "找不到内容 Job。");
      assertJobVersion(job, ctx.ifMatch);
      if (TERMINAL.has(job.status) && job.status !== "failed") fail(409, "CONTENT_JOB_NOT_CANCELLABLE", "任务已经进入终态。");
      job.pauseRequested = false;
      job.status = "cancelled";
      job.cancelledAt = this.clock().toISOString();
      job.revision += 1;
      job.updatedAt = job.cancelledAt;
      return job;
    });
    return this.getJob(id);
  }

  async approveJob(id, input, ctx) {
    assertionAdmin(ctx);
    if (input?.reviewed !== true) fail(422, "EXACT_REVIEW_REQUIRED", "必须明确确认已阅读完整结果、审核问题和视觉附件。");
    const job = await this.getJob(id);
    assertJobVersion(job, ctx.ifMatch);
    if (job.status !== "needs_review" || !job.result) fail(409, "CONTENT_JOB_NOT_REVIEWABLE", "只有待审且结果完整的 Job 可以批准。");
    const expectedResultHash = job.artifactKind === "pure_visual"
      ? job.result.contentHash
      : job.result.article
        ? articleHash(job.result.article)
        : job.result.contentHash;
    if (input.contentHash !== job.result.contentHash || input.contentHash !== expectedResultHash) {
      fail(409, "CONTENT_RESULT_CHANGED", "批准目标不是当前完整内容快照。");
    }
    if (["article", "article_visual"].includes(job.artifactKind) &&
        !job.reports.some(report => report.phase === "quality.final" && report.contentHash === input.contentHash)) {
      fail(409, "CONTENT_FINAL_AUDIT_REQUIRED", "当前内容快照没有绑定同一 hash 的最终独立审核报告。");
    }
    const openBlocking = (job.findings ?? []).filter(row => ["blocker", "major"].includes(row.severity) && row.status === "open");
    if (openBlocking.length) fail(422, "CONTENT_AUDIT_BLOCKED", "仍有 blocker 或 major 未解决。", { findings: openBlocking });
    await this.#write(`job_approved:${id}`, { contentHash: input.contentHash, note: input.note ?? "" }, ctx, (state, { actor, now }) => {
      const row = state.contentDirectorJobs.find(item => item.id === id);
      assertJobVersion(row, ctx.ifMatch);
      row.status = "approved";
      row.review = { reviewedBy: actor, reviewedAt: now.toISOString(), contentHash: input.contentHash, note: boundedText(input.note ?? "", "审核说明", 4000, { optional: true }) };
      row.revision += 1;
      row.updatedAt = now.toISOString();
      return contentDirectorEntity(row);
    });
    return this.getJob(id);
  }

  async materializeEdition(id, input, ctx) {
    assertionAdmin(ctx);
    if (!this.editorial) fail(503, "EDITORIAL_SERVICE_UNAVAILABLE", "编辑出版服务未配置。");
    const job = await this.getJob(id);
    assertJobVersion(job, ctx.ifMatch);
    if (job.status !== "approved" || !job.result?.article) fail(409, "CONTENT_JOB_NOT_APPROVED", "只有已批准文章可以物化为 Edition。");
    if (input?.contentHash !== job.result.contentHash) fail(409, "CONTENT_RESULT_CHANGED", "物化目标不是已批准快照。");
    const assetRefs = [];
    if (job.result.visuals?.length) {
      if (!this.mediaAssets) fail(503, "MEDIA_SERVICE_UNAVAILABLE", "视觉包物化需要媒体服务。");
      if (input.visualRightsConfirmed !== true) fail(422, "VISUAL_RIGHTS_REVIEW_REQUIRED", "请核对每张图的内容、来源、版权与隐私后再物化。");
      const rightsNote = boundedText(input.visualRightsNote, "visualRightsNote", 2000);
      for (const visual of job.result.visuals) {
        const png = visual.artifacts.find(item => item.mime === "image/png");
        if (!png) fail(409, "VISUAL_PNG_MISSING", "视觉包缺少真实 PNG。");
        const bytes = (await this.readArtifact(id, png.name)).bytes;
        const uploadCtx = {
          ...ctx,
          idempotencyKey: hashObject({ jobId: id, visualId: visual.id, action: "upload" }).slice(0, 64),
        };
        const asset = await this.mediaAssets.upload(Readable.from([bytes]), {
          contentType: "image/png",
          contentLength: bytes.length,
          name: `${visual.id}.png`,
          expectedSha256: png.sha256,
        }, uploadCtx);
        const reviewed = await this.mediaAssets.review(asset.id, {
          sha256: asset.sha256,
          rightsConfirmed: true,
          privacyConfirmed: true,
          rightsNote,
        }, {
          ...uploadCtx,
          ifMatch: asset.etag,
          idempotencyKey: hashObject({ jobId: id, visualId: visual.id, action: "review" }).slice(0, 64),
        });
        assetRefs.push({
          assetId: reviewed.id,
          sha256: reviewed.sha256,
          role: "image",
          alt: visual.spec.alt,
          caption: visual.spec.caption || "",
          locale: job.input.language,
        });
      }
    }
    const state = this.state();
    const claimIds = job.input.claimIds;
    claimRows(state, claimIds);
    const materializeStep = await this.#beginStep(id, "edition.materialize", `${job.result.contentHash}:${job.input.language}`, {
      contentHash: job.result.contentHash,
      storyId: job.editorialRef?.storyId ?? null,
      language: job.input.language,
    });
    let story = job.editorialRef?.storyId ? this.editorial.getStory(job.editorialRef.storyId) : null;
    if (!story) {
      story = await this.editorial.createStory({
        workingTitle: job.result.article.title,
        claimIds,
        topicIds: ["content-director", job.artifactKind, ...(job.result.article.tags ?? [])],
      }, ctx);
    }
    const currentStory = this.editorial.getStory(story.id);
    const visualBlocks = assetRefs.map(ref => ({ type: "image", assetId: ref.assetId, alt: ref.alt, caption: ref.caption }));
    const pureVisual = job.artifactKind === "pure_visual";
    const visualBody = pureVisual
      ? job.result.visuals.map(visual => visual.spec.caption || visual.spec.alt).filter(Boolean).join("\n\n") || "视觉内容包"
      : job.result.article.body;
    const edition = await this.editorial.createEdition(story.id, {
      locale: job.input.language,
      format: pureVisual ? "image_text" : "article",
      title: job.result.article.title,
      summary: pureVisual ? (job.result.visuals[0]?.spec.caption || job.result.visuals[0]?.spec.alt || "") : job.result.article.summary,
      body: visualBody,
      blocks: [...(pureVisual ? [] : job.result.article.blocks), ...visualBlocks],
      claimIds,
      assetRefs,
    }, { ...ctx, ifMatch: currentStory.etag });
    await this.#finishStep(id, materializeStep, {
      output: {
        storyId: story.id,
        editionId: edition.id,
        editionSnapshotHash: edition.snapshotHash,
        contentHash: job.result.contentHash,
      },
    });
    await this.store.mutate({
      type: "content_director.materialized",
      actor: ctx.actor,
      payload: { jobId: id, storyId: story.id, editionId: edition.id, contentHash: job.result.contentHash },
    }, next => {
      const row = next.contentDirectorJobs.find(item => item.id === id);
      assertJobVersion(row, ctx.ifMatch);
      row.editorialRef = { storyId: story.id, editionId: edition.id, materializedAt: this.clock().toISOString() };
      row.status = "completed";
      row.revision += 1;
      row.updatedAt = this.clock().toISOString();
      return row;
    });
    return { jobId: id, story, edition, visualArtifacts: job.result.visuals ?? [] };
  }

  async createContentOpsPlan(id, input, ctx) {
    assertionAdmin(ctx);
    if (!this.contentOps) fail(503, "CONTENT_OPS_UNAVAILABLE", "内容运营师服务未配置。");
    const job = await this.getJob(id);
    assertJobVersion(job, ctx.ifMatch);
    if (job.status !== "completed" || !job.editorialRef?.editionId) {
      fail(409, "CONTENT_EDITION_REQUIRED", "先物化不可变 Edition，再创建平台适配计划。");
    }
    const planInput = {
      storyId: job.editorialRef.storyId,
      editionId: job.editorialRef.editionId,
      targets: input?.targets,
      goal: input?.goal ?? (job.input.goal || job.result.article?.title || job.input.intent),
      budgetAuthorizationId: input?.budgetAuthorizationId ?? null,
      sourceArtifactIds: input?.sourceArtifactIds ?? [],
      nativeInputs: input?.nativeInputs ?? [],
    };
    const generated = this.contentOps.planTemplate(planInput, ctx);
    const packageValue = {
      schema: "pengmanager.content-publish-package/v1",
      jobId: id,
      editionId: job.editorialRef.editionId,
      editionHash: this.editorial.getEdition(job.editorialRef.editionId).snapshotHash,
      plan: generated.plan,
      gaps: generated.gaps,
      sourceRefs: generated.sourceRefs,
      publicationAuthorized: false,
      generatedAt: this.clock().toISOString(),
    };
    packageValue.packageHash = hashObject(packageValue);
    const artifact = await this.#writeArtifact(id, `content-ops-plan-${packageValue.packageHash.slice(0, 12)}.json`, packageValue, "application/json");
    const result = await this.#write(`content_ops_plan:${id}`, input, ctx, (state, { actor, now }) => {
      const row = state.contentDirectorJobs.find(item => item.id === id);
      assertJobVersion(row, ctx.ifMatch);
      const record = {
        id: `CPP-${randomBytes(10).toString("hex")}`,
        schema: "pengmanager.content-publish-package/v1",
        jobId: id,
        type: "content_ops_plan",
        packageHash: packageValue.packageHash,
        artifact,
        editionId: job.editorialRef.editionId,
        editionHash: packageValue.editionHash,
        gaps: generated.gaps,
        publicationAuthorized: false,
        createdBy: actor,
        createdAt: now.toISOString(),
      };
      state.contentPublishPackages.push(record);
      if (!row.artifacts.some(item => item.name === artifact.name && item.sha256 === artifact.sha256)) row.artifacts.push(artifact);
      row.contentOpsPlan = { packageId: record.id, packageHash: record.packageHash, artifact, gaps: generated.gaps };
      row.revision += 1;
      row.updatedAt = now.toISOString();
      return { ...structuredClone(record), plan: packageValue.plan, sourceRefs: generated.sourceRefs, etag: contentDirectorEtag(record) };
    });
    const step = await this.#beginStep(id, "content_ops.plan", packageValue.packageHash, {
      editionId: job.editorialRef.editionId,
      targetCount: generated.plan.targets.length,
    });
    await this.#finishStep(id, step, {
      output: { packageHash: packageValue.packageHash, gaps: generated.gaps.length, targetCount: generated.plan.targets.length },
      artifact,
    });
    return result;
  }

  async reviseVisuals(id, input, ctx) {
    assertionAdmin(ctx);
    const job = await this.getJob(id);
    assertJobVersion(job, ctx.ifMatch);
    if (!["article_visual", "pure_visual"].includes(job.artifactKind)) fail(409, "CONTENT_VISUAL_REVISION_NOT_APPLICABLE", "当前 Job 没有可修订的视觉包。");
    if (!["needs_review", "blocked", "approved"].includes(job.status) || !job.result) {
      fail(409, "CONTENT_VISUAL_REVISION_NOT_EDITABLE", "当前状态不能修订视觉包。");
    }
    if (!Array.isArray(input?.orderedVisualIds) || input.orderedVisualIds.length !== job.visualSpecs.length ||
        new Set(input.orderedVisualIds).size !== input.orderedVisualIds.length ||
        input.orderedVisualIds.some(visualId => !job.visualSpecs.some(row => row.id === visualId))) {
      fail(400, "CONTENT_VISUAL_ORDER_INVALID", "视觉顺序必须完整包含当前全部图表且不得重复。");
    }
    const updates = Array.isArray(input.updates) ? input.updates : [];
    if (updates.length > 4 || updates.some(update => !update || typeof update !== "object" ||
        !job.visualSpecs.some(row => row.id === update.visualId))) {
      fail(400, "CONTENT_VISUAL_UPDATE_INVALID", "视觉更新必须绑定当前图表，最多 4 项。");
    }
    const sourceHash = job.artifactKind === "article_visual" ? articleHash(job.result.article) : null;
    const authorizedClaimIds = job.input.claimIds ?? [];
    const activeById = new Map(job.visualSpecs.map(row => [row.id, row]));
    const nextVisuals = [];
    for (const [index, visualId] of input.orderedVisualIds.entries()) {
      const source = activeById.get(visualId);
      const update = updates.find(row => row.visualId === visualId);
      const spec = update?.spec
        ? normalizeVisualPlan({ visuals: [update.spec] }, { articleHash: sourceHash, authorizedClaimIds }).visuals[0]
        : structuredClone(source.spec);
      const specHash = hashObject(spec);
      if (specHash === source.specHash) {
        nextVisuals.push({ ...source, index });
        continue;
      }
      const nextId = `VIS-${hashObject({ jobId: id, supersedes: source.id, specHash }).slice(0, 20)}`;
      const existing = this.state().visualSpecs.find(row => row.id === nextId && row.jobId === id);
      if (existing) {
        nextVisuals.push({ ...existing, index });
        continue;
      }
      const svg = renderVisualSvg(spec);
      const png = await renderVisualPng(spec);
      const rendered = await inspectRenderedVisual(png.bytes);
      const artifacts = [
        await this.#writeArtifact(id, `${nextId}.json`, { ...spec, mermaidSource: mermaidSource(spec) }, "application/json"),
        await this.#writeArtifact(id, `${nextId}.svg`, svg.bytes, "image/svg+xml"),
        await this.#writeArtifact(id, `${nextId}.png`, png.bytes, "image/png"),
      ];
      nextVisuals.push({
        id: nextId,
        schema: "pengmanager.visual-spec-result/v1",
        jobId: id,
        index,
        spec,
        mermaidSource: mermaidSource(spec),
        specHash,
        sourceHash,
        rendered,
        supersedes: source.id,
        artifacts,
        createdAt: this.clock().toISOString(),
      });
    }
    let article = job.result.article ? { ...job.result.article, visualSpecRefs: nextVisuals.map(row => row.id) } : null;
    let findings = [];
    let report = null;
    if (job.artifactKind === "article_visual") {
      const allowedUrls = [
        ...(job.result.research?.sources ?? []).map(row => row.url),
        ...(job.input.claimIds ?? []).map(claimId => this.state().claims.find(claim => claim.id === claimId)?.source)
          .filter(value => /^https?:\/\//i.test(String(value))),
      ];
      const deterministicFindings = deterministicArticleFindings(article, {
        ...job.route.targetLength,
        allowedUrls,
        mustKeep: job.input.mustKeep,
        mustAvoid: job.input.mustAvoid,
      });
      report = await this.#auditArticle(id, {
        phase: "quality.final",
        article,
        brief: await this.#briefContext(job),
        research: job.result.research,
        deterministicFindings,
        visuals: nextVisuals,
        final: true,
      });
      findings = report.findings;
    }
    const blocking = findings.filter(row => ["blocker", "major"].includes(row.severity) && row.status === "open");
    const contentHash = job.artifactKind === "pure_visual"
      ? hashObject(nextVisuals.map(row => row.specHash))
      : articleHash(article);
    const result = {
      ...structuredClone(job.result),
      article,
      visuals: nextVisuals,
      findings,
      contentHash,
      complete: blocking.length === 0,
      revisedAt: this.clock().toISOString(),
    };
    const packageArtifact = await this.#writeArtifact(id, `content-package-${contentHash.slice(0, 12)}.json`, result, "application/json");
    await this.#write(`visual_revision:${id}:${contentHash}`, input, ctx, (state, { actor, now }) => {
      const row = state.contentDirectorJobs.find(item => item.id === id);
      assertJobVersion(row, ctx.ifMatch);
      for (const visual of nextVisuals) {
        if (!state.visualSpecs.some(item => item.id === visual.id && item.jobId === id)) state.visualSpecs.push(visual);
        for (const artifact of visual.artifacts) {
          if (!row.artifacts.some(item => item.name === artifact.name && item.sha256 === artifact.sha256)) row.artifacts.push(artifact);
        }
      }
      state.contentDirectorRevisions.push({
        id: `CDV-${randomBytes(10).toString("hex")}`,
        schema: "pengmanager.content-director-revision/v1",
        jobId: id,
        kind: "visuals",
        revision: state.contentDirectorRevisions.filter(item => item.jobId === id && item.kind === "visuals").length + 1,
        hash: contentHash,
        artifact: packageArtifact,
        createdBy: actor,
        createdAt: now.toISOString(),
      });
      if (!row.artifacts.some(item => item.name === packageArtifact.name && item.sha256 === packageArtifact.sha256)) row.artifacts.push(packageArtifact);
      row.visualSpecIds = nextVisuals.map(visual => visual.id);
      row.resultRef = packageArtifact;
      row.resultHash = contentHash;
      row.findings = findings;
      row.review = null;
      row.status = blocking.length ? "blocked" : "needs_review";
      row.revision += 1;
      row.updatedAt = now.toISOString();
      return contentDirectorEntity(row);
    });
    return this.getJob(id);
  }

  getPublicationStatus(id) {
    const state = this.state();
    const job = state.contentDirectorJobs.find(row => row.id === id);
    if (!job) fail(404, "CONTENT_JOB_NOT_FOUND", "找不到内容 Job。");
    const statuses = {
      routed: true,
      generated: Boolean(job.resultRef),
      reviewed: Boolean(job.review),
      editionMaterialized: Boolean(job.editorialRef?.editionId),
      contentOpsPlanned: Boolean(job.contentOpsPlan),
      publicSitePublished: false,
      externalPlatformPublished: false,
    };
    let story = null;
    let edition = null;
    let releases = [];
    if (job.editorialRef?.storyId && this.editorial) {
      story = this.editorial.getStory(job.editorialRef.storyId);
      edition = job.editorialRef.editionId ? this.editorial.getEdition(job.editorialRef.editionId) : null;
      releases = story.releases ?? [];
      statuses.publicSitePublished = releases.some(release => release.status === "published" && release.receipt?.dataMode === "real");
      statuses.publicSiteLiveUnverified = releases.some(release => release.status === "live_unverified");
    }
    statuses.externalPlatformPublished = (job.externalReceipts ?? []).some(receipt => receipt.dataMode === "real" && receipt.verifiedAt);
    return {
      schema: "pengmanager.content-publication-status/v1",
      jobId: id,
      statuses,
      editorial: job.editorialRef ?? null,
      contentOpsPlan: job.contentOpsPlan ?? null,
      story,
      edition,
      releases,
      contentOpsJob: job.contentOpsPlan?.jobId && this.contentOps
        ? this.#safeContentOpsJob(job.contentOpsPlan.jobId)
        : null,
      publicationAuthorized: false,
      externalPublicationAuthorized: false,
    };
  }

  #safeContentOpsJob(jobId) {
    try { return this.contentOps.getJob(jobId, { method: "local", actor: "content-director-read" }); }
    catch (error) { return { unavailable: true, code: error?.code ?? "CONTENT_OPS_UNAVAILABLE" }; }
  }

  async readArtifact(jobIdValue, name) {
    if (!ARTIFACT_NAME.test(name ?? "")) fail(400, "CONTENT_ARTIFACT_INVALID", "附件名称无效。");
    const state = this.state();
    const job = state.contentDirectorJobs.find(row => row.id === jobIdValue);
    if (!job) fail(404, "CONTENT_JOB_NOT_FOUND", "找不到内容 Job。");
    const artifact = job.artifacts.find(row => row.name === name);
    if (!artifact) fail(404, "CONTENT_ARTIFACT_NOT_FOUND", "找不到任务附件。");
    const root = await this.#ensureArtifactRoot();
    const directory = join(root, job.id);
    const file = join(directory, name);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.bytes) {
      fail(409, "CONTENT_ARTIFACT_CHANGED", "附件字节发生变化，停止读取。");
    }
    const bytes = await readFile(file);
    if (bytesHash(bytes) !== artifact.sha256) fail(409, "CONTENT_ARTIFACT_CHANGED", "附件摘要发生变化，停止读取。");
    return { ...artifact, bytes };
  }

  #resolveAttachmentInput(value, state, { allowPartial = false } = {}) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 200) fail(400, "CONTENT_ATTACHMENT_LIST_INVALID", "附件引用必须是有界数组。");
    return value.map((input, index) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) fail(400, "CONTENT_ATTACHMENT_INVALID", `附件引用 ${index + 1} 无效。`);
      if (input.kind === "url") return { kind: "url", id: input.id };
      if (!ATTACHMENT_ID.test(input.id ?? "")) {
        if (allowPartial && (input.id === undefined || input.id === null)) return input;
        fail(404, "CONTENT_ATTACHMENT_NOT_FOUND", `附件引用 ${index + 1} 不存在或尚未上传。`);
      }
      const row = state.contentDirectorAttachments.find(item => item.id === input.id);
      if (!row) fail(404, "CONTENT_ATTACHMENT_NOT_FOUND", `附件引用 ${index + 1} 不存在。`);
      return {
        kind: row.kind,
        id: row.id,
        mime: row.mime,
        name: row.name,
        size: row.size,
        sha256: row.sha256,
        speechLikely: input.speechLikely === true || row.speechLikely === true,
        durationSec: input.durationSec ?? row.durationSec,
        characters: row.characters,
      };
    });
  }

  #attachmentBindings(attachments, state) {
    return attachments.filter(row => row.kind !== "url").map(row => {
      const current = state.contentDirectorAttachments.find(item => item.id === row.id);
      if (!current || current.sha256 !== row.sha256 || current.mime !== row.mime || current.size !== row.size) {
        fail(409, "CONTENT_ATTACHMENT_CHANGED", "附件登记在创建任务前发生变化。");
      }
      return { id: current.id, mime: current.mime, size: current.size, sha256: current.sha256 };
    });
  }

  #assertAttachmentBindings(bindings, state) {
    for (const binding of bindings) {
      const row = state.contentDirectorAttachments.find(item => item.id === binding.id);
      if (!row || row.mime !== binding.mime || row.size !== binding.size || row.sha256 !== binding.sha256) {
        fail(409, "CONTENT_ATTACHMENT_CHANGED", "附件在任务创建期间发生变化。");
      }
    }
  }

  async #write(scope, input, ctx, handler) {
    const actor = assertionAdmin(ctx);
    const requestHash = hashObject(input);
    const keyHash = hashObject({ actor, scope, key: ctx.idempotencyKey });
    const { result } = await this.store.mutate({
      type: `content_director.${scope.split(":")[0]}`,
      actor,
      payload: { scope, requestHash },
    }, state => {
      const previous = state.contentDirectorRequests.find(row => row.keyHash === keyHash);
      if (previous) {
        if (previous.requestHash !== requestHash) fail(409, "IDEMPOTENCY_CONFLICT", "幂等键已用于不同请求。");
        return JsonStore.noChange(previous.result);
      }
      const result = handler(state, { actor, now: this.clock(), payload: {} });
      state.contentDirectorRequests.push({
        id: requestId(),
        keyHash,
        actor,
        scope,
        requestHash,
        result: structuredClone(result),
        at: this.clock().toISOString(),
      });
      return result;
    });
    return result;
  }

  async #updateJob(id, patch, type = "content_director.job_updated") {
    const { result } = await this.store.mutate({ type, actor: "content-director-worker", payload: { jobId: id } }, state => {
      const job = state.contentDirectorJobs.find(row => row.id === id);
      if (!job) fail(404, "CONTENT_JOB_NOT_FOUND", "找不到内容 Job。");
      if (job.status === "cancelled") fail(409, "CONTENT_JOB_CANCELLED", "任务已取消。");
      Object.assign(job, patch, { revision: job.revision + 1, updatedAt: this.clock().toISOString() });
      return job;
    });
    return result;
  }

  async #assertLive(id) {
    const state = this.state();
    const job = state.contentDirectorJobs.find(row => row.id === id);
    if (!job || job.status === "cancelled") fail(409, "CONTENT_JOB_CANCELLED", "任务已取消。");
    if (job.pauseRequested) fail(409, "CONTENT_JOB_PAUSED", "任务已请求暂停。");
    return job;
  }

  async #briefContext(job) {
    const state = this.state();
    const claims = claimRows(state, job.input.claimIds);
    const materials = [];
    let remaining = MAX_SOURCE_MATERIAL_CHARACTERS;
    for (const attachment of job.input.attachments ?? []) {
      if (attachment.kind === "url" || !["document", "transcript", "data", "code"].includes(attachment.kind)) continue;
      if (remaining <= 0) {
        materials.push({ id: attachment.id, name: attachment.name, mime: attachment.mime, sha256: attachment.sha256, text: null, truncated: true });
        continue;
      }
      if (!["text/plain", "text/markdown", "text/csv", "text/javascript", "text/x-python", "application/json"].includes(attachment.mime)) {
        materials.push({ id: attachment.id, name: attachment.name, mime: attachment.mime, sha256: attachment.sha256, text: null, truncated: false });
        continue;
      }
      const opened = await this.readAttachment(attachment.id);
      const full = new TextDecoder("utf-8", { fatal: true }).decode(opened.bytes);
      const text = full.slice(0, remaining);
      remaining -= text.length;
      materials.push({
        id: attachment.id,
        name: attachment.name,
        mime: attachment.mime,
        sha256: attachment.sha256,
        text,
        truncated: text.length !== full.length,
      });
    }
    return {
      topic: job.input.intent,
      thesis: job.input.authorThoughts[0] ?? job.input.intent,
      authorThoughts: job.input.authorThoughts,
      audience: job.input.audience,
      goal: job.input.goal,
      language: job.input.language,
      platforms: job.input.platforms,
      targetLength: normalizeArticleLength(job.route.targetLength),
      mustKeep: job.input.mustKeep,
      mustAvoid: job.input.mustAvoid,
      claimIds: job.input.claimIds,
      claims: claims.map(claim => ({ id: claim.id, text: claim.text, type: claim.type, source: claim.source })),
      sourceMaterials: materials,
    };
  }

  #schedule(id) {
    this.#scheduled.add(id);
    this.#scheduleDrain();
  }

  #scheduleDrain() {
    if (this.#draining) return;
    this.#draining = Promise.resolve().then(() => this.#drain()).finally(() => {
      this.#draining = null;
      try {
        const queued = this.store.snapshot().contentDirectorJobs.some(job => job.status === "queued" && !job.pauseRequested && !this.#running.has(job.id));
        if (queued && this.#running.size < MAX_JOBS_RUNNING) this.#scheduleDrain();
      } catch (error) {
        if (error?.code !== "STATE_STORE_CLOSED") this.#schedulerError = error;
      }
    });
  }

  async #drain() {
    while (this.#running.size < MAX_JOBS_RUNNING) {
      const state = this.state();
      const candidate = [...state.contentDirectorJobs]
        .filter(job => job.status === "queued" && !job.pauseRequested && !this.#running.has(job.id))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
      if (!candidate) return;
      this.#scheduled.delete(candidate.id);
      this.#running.add(candidate.id);
      try {
        await this.store.mutate({
          type: "content_director.job_running",
          actor: "content-director-worker",
          payload: { jobId: candidate.id },
        }, next => {
          const row = next.contentDirectorJobs.find(item => item.id === candidate.id);
          if (!row || row.status !== "queued" || row.pauseRequested) return JsonStore.noChange(row);
          row.status = "running";
          row.revision += 1;
          row.updatedAt = this.clock().toISOString();
          return row;
        });
      } catch (error) {
        this.#running.delete(candidate.id);
        throw error;
      }
      void this.#executeJob(candidate.id)
        .catch(() => undefined)
        .finally(() => {
          this.#running.delete(candidate.id);
          this.#scheduleDrain();
        });
    }
  }

  #successfulStep(id, kind, key) {
    return this.state().contentDirectorSteps.find(step =>
      step.jobId === id && step.kind === kind && step.key === key && step.status === "succeeded");
  }

  async #stepJsonArtifact(id, step) {
    if (!step?.artifact?.name) return null;
    const artifact = await this.readArtifact(id, step.artifact.name);
    return JSON.parse(artifact.bytes.toString("utf8"));
  }

  async #beginStep(id, kind, key, input) {
    const state = this.state();
    const existing = state.contentDirectorSteps.find(step => step.jobId === id && step.kind === kind && step.key === key);
    if (existing?.status === "succeeded") {
      if (existing.inputHash !== hashObject(input)) fail(409, "CONTENT_STEP_INPUT_CHANGED", "已成功阶段的实际输入发生变化，不能复用旧输出。");
      return existing;
    }
    const row = existing ?? {
      id: stepId(),
      schema: "pengmanager.content-director-step/v1",
      jobId: id,
      kind,
      key,
      status: "running",
      inputHash: hashObject(input),
      output: null,
      artifact: null,
      receipt: null,
      error: null,
      attempts: 0,
      startedAt: this.clock().toISOString(),
      finishedAt: null,
      createdAt: this.clock().toISOString(),
      updatedAt: this.clock().toISOString(),
    };
    await this.store.mutate({ type: "content_director.step_started", actor: "content-director-worker", payload: { jobId: id, stepId: row.id, kind, key } }, next => {
      const job = next.contentDirectorJobs.find(item => item.id === id);
      if (job.status === "cancelled") fail(409, "CONTENT_JOB_CANCELLED", "任务已取消。");
      if (!existing) next.contentDirectorSteps.push(row);
      const current = next.contentDirectorSteps.find(step => step.jobId === id && step.kind === kind && step.key === key);
      Object.assign(current, {
        status: "running",
        inputHash: hashObject(input),
        error: null,
        attempts: (current.attempts ?? 0) + 1,
        startedAt: this.clock().toISOString(),
        updatedAt: this.clock().toISOString(),
      });
      if (!job.stepRefs.includes(current.id)) job.stepRefs.push(current.id);
      job.currentStep = kind;
      job.updatedAt = this.clock().toISOString();
      return current;
    });
    return this.state().contentDirectorSteps.find(step => step.jobId === id && step.kind === kind && step.key === key);
  }

  async #finishStep(id, stepValue, { output = null, artifact = null, receipt = null } = {}) {
    await this.store.mutate({ type: "content_director.step_succeeded", actor: "content-director-worker", payload: { jobId: id, stepId: stepValue.id, kind: stepValue.kind } }, state => {
      const step = state.contentDirectorSteps.find(row => row.id === stepValue.id);
      const job = state.contentDirectorJobs.find(row => row.id === id);
      Object.assign(step, {
        status: "succeeded",
        output,
        artifact,
        receipt,
        error: null,
        finishedAt: this.clock().toISOString(),
        updatedAt: this.clock().toISOString(),
      });
      if (artifact && !job.artifacts.some(row => row.name === artifact.name && row.sha256 === artifact.sha256)) job.artifacts.push(artifact);
      job.updatedAt = this.clock().toISOString();
      return step;
    });
    return this.state().contentDirectorSteps.find(row => row.id === stepValue.id);
  }

  async #markJobFailure(id, error) {
    const state = this.state();
    const job = state.contentDirectorJobs.find(row => row.id === id);
    if (!job || job.status === "cancelled") return;
    const status = error?.unknown === true ? "unknown" : ["CONTENT_JOB_PAUSED"].includes(error?.code) ? "needs_resume" : "failed";
    await this.store.mutate({ type: "content_director.job_failed", actor: "content-director-worker", payload: { jobId: id, code: error?.code ?? "CONTENT_DIRECTOR_FAILED" } }, next => {
      const row = next.contentDirectorJobs.find(item => item.id === id);
      row.status = status;
      row.error = {
        code: typeof error?.code === "string" ? error.code : "CONTENT_DIRECTOR_FAILED",
        message: typeof error?.message === "string" ? error.message.slice(0, 1000) : "内容任务失败。",
        unknown: error?.unknown === true,
      };
      row.revision += 1;
      row.updatedAt = this.clock().toISOString();
      const running = next.contentDirectorSteps.find(step => step.jobId === id && step.status === "running");
      if (running) {
        running.status = "failed";
        running.error = row.error;
        running.finishedAt = row.updatedAt;
        running.updatedAt = row.updatedAt;
      }
      return row;
    });
  }

  async #processArticle(id) {
    if (!this.model) fail(503, "CONTENT_MODEL_UNAVAILABLE", "文章生产线需要当前授权模型。");
    const state = this.state();
    const job = state.contentDirectorJobs.find(row => row.id === id);
    const brief = await this.#briefContext(job);
    const briefHash = hashObject(brief);
    let step = await this.#beginStep(id, "brief.compile", `brief:${briefHash}`, brief);
    const briefArtifact = await this.#writeArtifact(id, `brief-${briefHash.slice(0, 12)}.json`, brief, "application/json");
    await this.#finishStep(id, step, { output: { briefHash }, artifact: briefArtifact });
    await this.#assertLive(id);

    let research = { plan: null, sources: [], claims: brief.claims };
    if (job.input.allowWebResearch) {
      const planKey = `plan:${briefHash}`;
      const cachedPlan = this.#successfulStep(id, "research.plan", planKey);
      if (cachedPlan?.artifact?.name) {
        research.plan = validateResearchPlan(await this.#stepJsonArtifact(id, cachedPlan));
      } else {
        step = await this.#beginStep(id, "research.plan", planKey, brief);
        const planned = await this.model.planResearch(brief);
        research.plan = validateResearchPlan(planned.value);
        const planArtifact = await this.#writeArtifact(id, `research-plan-${hashObject(research.plan).slice(0, 12)}.json`, research.plan, "application/json");
        await this.#finishStep(id, step, { output: { questions: research.plan.questions.length }, artifact: planArtifact, receipt: planned.receipt });
      }
      const allSources = [];
      for (const question of research.plan.questions.slice(0, 8)) {
        await this.#assertLive(id);
        const sourceKey = `question:${briefHash}:${question.id}`;
        const cachedSources = this.#successfulStep(id, "research.collect", sourceKey);
        if (cachedSources?.artifact?.name) {
          allSources.push(...(await this.#stepJsonArtifact(id, cachedSources)).sources);
        } else {
          step = await this.#beginStep(id, "research.collect", sourceKey, question);
          const result = await this.model.search(question.question, { count: 5 });
          const fetchedAt = this.clock().toISOString();
          const rows = [];
          for (const source of result.results ?? []) {
            const url = requirePublicUrl(String(source.url ?? ""), "research.source.url");
            const title = String(source.title ?? "").trim().slice(0, 500) || url;
            const snippet = String(source.snippet ?? "").trim().slice(0, 2000);
            rows.push({
              questionId: question.id,
              title,
              url,
              domain: String(source.domain ?? new URL(url).hostname).slice(0, 240),
              snippet,
              fetchedAt,
              snippetHash: hashObject({ url, title, snippet }),
              searchReceiptHash: result.responseHash ?? null,
            });
          }
          const sourceArtifact = await this.#writeArtifact(id, `research-${question.id}-${hashObject(rows).slice(0, 12)}.json`, { question, sources: rows }, "application/json");
          await this.#finishStep(id, step, { output: { sourceCount: rows.length, questionId: question.id }, artifact: sourceArtifact });
          allSources.push(...rows);
        }
      }
      research.sources = [...new Map(allSources.map(source => [`${source.url}:${source.snippetHash}`, source])).values()].slice(0, 24);
      const sourceBundleArtifact = await this.#writeArtifact(id, `research-sources-${hashObject(research.sources).slice(0, 12)}.json`, research, "application/json");
      await this.store.mutate({ type: "content_director.research_bundle_recorded", actor: "content-director-worker", payload: { jobId: id, sourceCount: research.sources.length } }, next => {
        const existing = next.contentResearchBundles.find(row => row.jobId === id && row.briefHash === briefHash);
        if (existing) Object.assign(existing, { sources: research.sources, artifact: sourceBundleArtifact, updatedAt: this.clock().toISOString() });
        else next.contentResearchBundles.push({
          id: `CRB-${randomBytes(10).toString("hex")}`,
          schema: "pengmanager.content-research-bundle/v1",
          jobId: id,
          briefHash,
          plan: research.plan,
          sources: research.sources,
          artifact: sourceBundleArtifact,
          createdAt: this.clock().toISOString(),
          updatedAt: this.clock().toISOString(),
        });
        return existing ?? null;
      });
    } else {
      const claimsKey = `claims-only:${briefHash}`;
      const cachedResearch = this.#successfulStep(id, "research.plan", claimsKey);
      if (cachedResearch?.artifact?.name) {
        research = await this.#stepJsonArtifact(id, cachedResearch);
      } else {
        step = await this.#beginStep(id, "research.plan", claimsKey, brief);
        const planArtifact = await this.#writeArtifact(id, `research-claims-${briefHash.slice(0, 12)}.json`, research, "application/json");
        await this.#finishStep(id, step, { output: { mode: "claims-only", sourceCount: brief.claims.length }, artifact: planArtifact });
      }
    }

    let outline;
    if (job.outlineRef?.artifact?.name) {
      outline = validateOutline(await this.#stepJsonArtifact(id, job.outlineRef), brief);
    } else {
      const outlineKey = `outline:${briefHash}:${hashObject(research.sources)}`;
      const cachedOutline = this.#successfulStep(id, "outline.generate", outlineKey);
      if (cachedOutline?.artifact?.name) {
        outline = validateOutline(await this.#stepJsonArtifact(id, cachedOutline), brief);
      } else {
        step = await this.#beginStep(id, "outline.generate", outlineKey, { brief, research });
        const outlineResult = await this.model.generateOutline({ brief, research });
        outline = validateOutline(outlineResult.value, brief);
        const outlineArtifact = await this.#writeArtifact(id, `outline-${hashObject(outline).slice(0, 12)}.json`, outline, "application/json");
        await this.#finishStep(id, step, { output: { sectionCount: outline.sections.length, outlineHash: hashObject(outline) }, artifact: outlineArtifact, receipt: outlineResult.receipt });
      }
    }
    const outlineHash = hashObject(outline);
    const freezeKey = `frozen:${outlineHash}`;
    if (!this.#successfulStep(id, "outline.freeze", freezeKey)) {
      step = await this.#beginStep(id, "outline.freeze", freezeKey, outline);
      const outlineArtifact = await this.#writeArtifact(id, `outline-${hashObject(outline).slice(0, 12)}.json`, outline, "application/json");
      await this.#finishStep(id, step, { output: { outlineHash }, artifact: outlineArtifact });
    }

    const authorizedClaimIds = new Set(job.input.claimIds);
    const sections = [];
    for (const [index, section] of outline.sections.entries()) {
      await this.#assertLive(id);
      const evidence = {
        claims: brief.claims.filter(claim => section.claimIds.includes(claim.id)),
        sources: sourcesForSection(research.sources, section),
      };
      const researchKey = `${outlineHash}:${section.key}`;
      const researchStep = await this.#beginStep(id, "section.research", researchKey, { section, evidence });
      const evidenceArtifact = await this.#writeArtifact(id, `section-research-${section.key}-${hashObject(evidence).slice(0, 10)}.json`, evidence, "application/json");
      await this.#finishStep(id, researchStep, { output: { claimCount: evidence.claims.length, sourceCount: evidence.sources.length }, artifact: evidenceArtifact });
      const input = {
        brief,
        research: { sources: evidence.sources, claims: evidence.claims },
        outline,
        section,
        previousSections: sections.map(row => ({ title: row.title, summary: row.body.slice(0, 500) })),
        nextSection: outline.sections[index + 1] ?? null,
      };
      const drafted = await this.#draftSection(id, input, section, authorizedClaimIds, outlineHash);
      sections.push(drafted);
    }

    const buildArticle = (rows, visuals = []) => ({
      title: outline.title,
      summary: outline.summary,
      body: composeArticleBody(rows),
      sections: rows,
      blocks: buildArticleBlocks(rows),
      tags: deriveTags(brief),
      language: brief.language,
      claimIds: brief.claimIds,
      visualSpecRefs: visuals.map(row => row.id),
    });
    let article = buildArticle(sections);
    const assembleKey = hashObject({ outlineHash, sections: sections.map(section => hashObject(section)) });
    step = await this.#beginStep(id, "article.assemble", assembleKey, { sectionCount: sections.length, outlineHash });
    const assembledArtifact = await this.#writeArtifact(id, `article-${articleHash(article).slice(0, 12)}.md`, article.body, "text/markdown");
    await this.#finishStep(id, step, { output: { articleHash: articleHash(article), characters: article.body.replace(/\s+/g, "").length }, artifact: assembledArtifact });

    const allowedUrls = [...research.sources.map(row => row.url), ...brief.claims.map(row => row.source).filter(value => /^https?:\/\//i.test(String(value)))];
    let deterministicFindings = deterministicArticleFindings(article, {
      ...brief.targetLength,
      allowedUrls,
      mustKeep: brief.mustKeep,
      mustAvoid: brief.mustAvoid,
    });
    let report = await this.#auditArticle(id, {
      phase: "quality.review",
      article,
      brief,
      research,
      deterministicFindings,
    });
    let blocking = report.findings.filter(row => ["blocker", "major"].includes(row.severity));
    for (let round = 1; round <= 2 && blocking.some(row => ["blocker", "major"].includes(row.severity)); round += 1) {
      const indexes = [...new Set(blocking
        .map(row => /section[-:](\d+)/i.exec(row.location ?? "")?.[1])
        .filter(value => value !== undefined)
        .map(Number))]
        .filter(index => Number.isSafeInteger(index) && outline.sections[index]);
      if (!indexes.length) break;
      for (const index of indexes) {
        await this.#assertLive(id);
        const sectionFindings = blocking.filter(row => new RegExp(`section[-:]${index}(?:\\D|$)`, "i").test(row.location ?? ""));
        sections[index] = await this.#repairSection(id, {
          brief,
          research: { sources: research.sources, claims: brief.claims },
          outline,
          section: outline.sections[index],
          currentSection: sections[index],
          findings: sectionFindings,
          round,
        }, outline.sections[index], authorizedClaimIds, hashObject(sections[index]));
      }
      article = buildArticle(sections);
      deterministicFindings = deterministicArticleFindings(article, {
        ...brief.targetLength,
        allowedUrls,
        mustKeep: brief.mustKeep,
        mustAvoid: brief.mustAvoid,
      });
      report = await this.#auditArticle(id, {
        phase: "quality.review",
        article,
        brief,
        research,
        deterministicFindings,
        repairRound: round,
      });
      blocking = report.findings.filter(row => ["blocker", "major"].includes(row.severity));
    }

    let visuals = [];
    if (!blocking.length && (job.route.needs.visuals || job.input.enableVisuals)) {
      visuals = await this.#createVisuals(id, article, brief);
    }
    article = buildArticle(sections, visuals);
    deterministicFindings = deterministicArticleFindings(article, {
      ...brief.targetLength,
      allowedUrls,
      mustKeep: brief.mustKeep,
      mustAvoid: brief.mustAvoid,
    });
    report = await this.#auditArticle(id, {
      phase: "quality.final",
      article,
      brief,
      research,
      deterministicFindings,
      visuals,
      final: true,
    });
    blocking = report.findings.filter(row => ["blocker", "major"].includes(row.severity));

    const findings = report.findings;
    const contentHash = articleHash(article);
    const result = {
      schema: "pengmanager.content-director-result/v1",
      jobId: id,
      artifactKind: job.artifactKind,
      article,
      research,
      outline,
      findings,
      visuals,
      contentHash,
      complete: blocking.length === 0,
      frozenAt: this.clock().toISOString(),
    };
    const packageArtifact = await this.#writeArtifact(id, `content-package-${contentHash.slice(0, 12)}.json`, result, "application/json");
    const freezeStep = await this.#beginStep(id, "package.freeze", "package", { contentHash });
    await this.#finishStep(id, freezeStep, { output: { contentHash, blockerCount: blocking.length, visualCount: visuals.length }, artifact: packageArtifact });
    await this.#updateJob(id, {
      status: blocking.length ? "blocked" : "needs_review",
      resultRef: packageArtifact,
      resultHash: contentHash,
      findings,
      visualSpecIds: visuals.map(row => row.id),
      missing: [],
      currentStep: "package.freeze",
    }, "content_director.job_result_frozen");
  }

  async #repairSection(id, input, section, authorizedClaimIds, beforeHash) {
    const key = `${section.key}:round-${input.round}:${beforeHash}`;
    const cached = this.#successfulStep(id, "article.repair", key);
    if (cached?.artifact?.name) {
      const markdown = (await this.readArtifact(id, cached.artifact.name)).bytes.toString("utf8").trim();
      const lines = markdown.split("\n");
      const first = lines.shift() ?? "";
      const title = /^##\s+(.+)$/.test(first) ? first.replace(/^##\s+/, "") : section.title;
      return validateSectionDraft({ title, body: lines.join("\n").trim(), paragraphs: lines.join("\n").trim().split(/\n\s*\n/), claimIds: cached.output?.claimIds ?? [] }, section, authorizedClaimIds);
    }
    if (typeof this.model.repairSection !== "function") {
      fail(503, "CONTENT_REPAIR_UNAVAILABLE", "当前模型适配器不支持定点章节修复。");
    }
    const step = await this.#beginStep(id, "article.repair", key, input);
    const result = await this.model.repairSection(input);
    const repaired = validateSectionDraft(result.value, section, authorizedClaimIds);
    const allowedChanges = input.findings.flatMap(finding => finding.allowedChanges ?? []);
    const allowsWholeSection = allowedChanges.some(value => /^section(?::|-)\d+$/i.test(value) || value === section.key);
    if (!allowsWholeSection) {
      const allowedParagraphs = new Set(allowedChanges
        .map(value => /paragraph[-: ]*(\d+)/i.exec(value)?.[1])
        .filter(value => value !== undefined)
        .map(Number));
      if (!allowedParagraphs.size) fail(422, "REPAIR_SCOPE_REQUIRED", "finding 没有声明允许修改的段落，停止定点修复。");
      if (repaired.paragraphs.length !== input.currentSection.paragraphs.length) {
        fail(422, "REPAIR_SCOPE_VIOLATION", "定点修复改变了段落数量，超出允许范围。");
      }
      const changed = repaired.paragraphs
        .map((value, index) => value === input.currentSection.paragraphs[index] ? null : index)
        .filter(index => index !== null);
      if (changed.some(index => !allowedParagraphs.has(index + 1))) {
        fail(422, "REPAIR_SCOPE_VIOLATION", "定点修复修改了未授权段落。");
      }
    }
    const artifact = await this.#writeArtifact(id, `repair-${section.key}-r${input.round}-${hashObject(repaired).slice(0, 10)}.md`, `## ${repaired.title}\n\n${repaired.body}\n`, "text/markdown");
    await this.#finishStep(id, step, {
      output: {
        sectionKey: section.key,
        round: input.round,
        beforeHash,
        afterHash: hashObject(repaired),
        findingIds: input.findings.map(finding => finding.id),
        claimIds: repaired.claimIds,
      },
      artifact,
      receipt: result.receipt,
    });
    await this.store.mutate({ type: "content_director.repair_recorded", actor: "content-director-worker", payload: { jobId: id, sectionKey: section.key, round: input.round } }, state => {
      state.contentRepairAttempts.push({
        id: `CRP-${randomBytes(10).toString("hex")}`,
        schema: "pengmanager.content-repair-attempt/v1",
        jobId: id,
        sectionKey: section.key,
        round: input.round,
        findingIds: input.findings.map(finding => finding.id),
        beforeHash,
        afterHash: hashObject(repaired),
        artifact,
        createdAt: this.clock().toISOString(),
      });
      return null;
    });
    return repaired;
  }

  async #auditArticle(id, { phase, article, brief, research, deterministicFindings, visuals = [], repairRound = 0, final = false }) {
    const contentHash = articleHash(article);
    const existing = this.state().contentAuditReports.find(report =>
      report.jobId === id && report.phase === phase && report.contentHash === contentHash && (report.repairRound ?? 0) === repairRound);
    if (existing) return existing;
    const deterministicKey = `${contentHash}:round-${repairRound}`;
    let deterministicStep = await this.#beginStep(id, "quality.deterministic", deterministicKey, { contentHash, repairRound });
    const deterministicArtifact = await this.#writeArtifact(id, `quality-deterministic-${contentHash.slice(0, 10)}-r${repairRound}-${hashObject(deterministicFindings).slice(0, 8)}.json`, deterministicFindings, "application/json");
    await this.#finishStep(id, deterministicStep, {
      output: {
        findingCount: deterministicFindings.length,
        blockers: deterministicFindings.filter(row => row.severity === "blocker").length,
        majors: deterministicFindings.filter(row => row.severity === "major").length,
      },
      artifact: deterministicArtifact,
    });
    const auditKey = `${contentHash}:round-${repairRound}:${final ? "final" : "review"}`;
    const step = await this.#beginStep(id, final ? "quality.final" : "quality.review", auditKey, { article, brief, research, visuals });
    const method = final ? (this.model.finalAuditArticle ?? this.model.auditArticle) : this.model.auditArticle;
    if (typeof method !== "function") fail(503, "CONTENT_AUDIT_UNAVAILABLE", "当前模型适配器不支持独立审核。");
    const result = await method.call(this.model, { article, brief, research, visuals, deterministicFindings });
    if (final && (!result.value.coverage || typeof result.value.coverage !== "object" ||
        ["facts", "structure", "expression", "policy", "technical", "visual"].some(key => !Object.hasOwn(result.value.coverage, key)))) {
      fail(502, "CONTENT_FINAL_COVERAGE_INVALID", "最终审核报告缺少事实、结构、表达、政策、技术或视觉覆盖。");
    }
    const deterministic = deterministicFindings.map((row, index) => ({ id: `D-${String(index + 1).padStart(3, "0")}`, ...row, status: "open" }));
    const modelFindings = normalizeFindings(result.value.findings);
    const report = {
      id: `CAR-${randomBytes(10).toString("hex")}`,
      schema: "pengmanager.content-audit-report/v1",
      jobId: id,
      phase,
      repairRound,
      contentHash,
      assessment: boundedText(String(result.value.assessment ?? ""), "审核结论", 20_000, { optional: true }),
      coverage: result.value.coverage && typeof result.value.coverage === "object" ? result.value.coverage : {},
      findings: [...deterministic, ...modelFindings],
      modelReceipt: result.receipt,
      generatedAt: this.clock().toISOString(),
    };
    report.reportHash = hashObject(report);
    const reportArtifact = await this.#writeArtifact(id, `audit-${phase}-${report.reportHash.slice(0, 12)}.json`, report, "application/json");
    await this.store.mutate({ type: "content_director.audit_recorded", actor: "content-director-worker", payload: { jobId: id, reportHash: report.reportHash, phase } }, state => {
      state.contentAuditReports.push(report);
      const current = state.contentDirectorJobs.find(row => row.id === id);
      current.findings = report.findings;
      current.updatedAt = this.clock().toISOString();
      return report;
    });
    await this.#finishStep(id, step, {
      output: {
        reportHash: report.reportHash,
        phase,
        blockers: report.findings.filter(row => row.severity === "blocker").length,
        majors: report.findings.filter(row => row.severity === "major").length,
      },
      artifact: reportArtifact,
      receipt: result.receipt,
    });
    return report;
  }

  async #draftSection(id, input, section, authorizedClaimIds, suffix = "draft") {
    const cached = this.#successfulStep(id, "section.draft", `${section.key}:${suffix}`);
    if (cached?.artifact?.name) {
      const markdown = (await this.readArtifact(id, cached.artifact.name)).bytes.toString("utf8").trim();
      const lines = markdown.split("\n");
      const first = lines.shift() ?? "";
      const title = /^##\s+(.+)$/.test(first) ? first.replace(/^##\s+/, "") : section.title;
      const body = lines.join("\n").trim();
      return validateSectionDraft({ title, body, paragraphs: body.split(/\n\s*\n/), claimIds: cached.output?.claimIds ?? [] }, section, authorizedClaimIds);
    }
    const step = await this.#beginStep(id, "section.draft", `${section.key}:${suffix}`, input);
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await this.model.draftSection({ ...input, attempt });
        const drafted = validateSectionDraft(result.value, section, authorizedClaimIds);
        const artifact = await this.#writeArtifact(id, `section-${section.key}-${hashObject(drafted).slice(0, 10)}.md`, `## ${drafted.title}\n\n${drafted.body}\n`, "text/markdown");
        await this.#finishStep(id, step, {
          output: { sectionKey: section.key, title: drafted.title, characters: drafted.body.replace(/\s+/g, "").length, claimIds: drafted.claimIds },
          artifact,
          receipt: result.receipt,
        });
        return drafted;
      } catch (error) {
        lastError = error;
        if (attempt === 2) break;
      }
    }
    throw lastError ?? fail(502, "CONTENT_SECTION_FAILED", "章节生成失败。");
  }

  async #createVisuals(id, article, brief) {
    const state = this.state();
    const job = state.contentDirectorJobs.find(row => row.id === id);
    const existing = (job.visualSpecIds ?? [])
      .map(visualId => state.visualSpecs.find(row => row.id === visualId && row.jobId === id))
      .filter(Boolean)
      .sort((a, b) => a.index - b.index);
    if (existing.length) return existing;
    const sourceHash = articleHash(article);
    const planStep = await this.#beginStep(id, "visual.plan", `visuals:${sourceHash}`, { article: sourceHash, brief });
    const result = await this.model.planVisuals({ article, brief, contract: "architecture|flow nodes+edges; chart data; infographic items" });
    const plan = normalizeVisualPlan(result.value, { articleHash: sourceHash, authorizedClaimIds: brief.claimIds });
    const planArtifact = await this.#writeArtifact(id, `visual-plan-${hashObject(plan).slice(0, 12)}.json`, plan, "application/json");
    await this.#finishStep(id, planStep, { output: { visualCount: plan.visuals.length }, artifact: planArtifact, receipt: result.receipt });
    const rows = [];
    for (const [index, spec] of plan.visuals.entries()) {
      const renderStep = await this.#beginStep(id, "visual.render", `visual:${sourceHash}:${index + 1}`, spec);
      const visualId = stableVisualId(id, index, hashObject(spec));
      const svg = renderVisualSvg(spec);
      const png = await renderVisualPng(spec);
      const rendered = await inspectRenderedVisual(png.bytes);
      const specArtifact = await this.#writeArtifact(id, `${visualId}.json`, { ...spec, mermaidSource: mermaidSource(spec) }, "application/json");
      const svgArtifact = await this.#writeArtifact(id, `${visualId}.svg`, svg.bytes, "image/svg+xml");
      const pngArtifact = await this.#writeArtifact(id, `${visualId}.png`, png.bytes, "image/png");
      const row = {
        id: visualId,
        schema: "pengmanager.visual-spec-result/v1",
        jobId: id,
        index,
        spec,
        mermaidSource: mermaidSource(spec),
        specHash: png.specHash,
        sourceHash,
        rendered,
        artifacts: [specArtifact, svgArtifact, pngArtifact],
        createdAt: this.clock().toISOString(),
      };
      await this.store.mutate({ type: "content_director.visual_created", actor: "content-director-worker", payload: { jobId: id, visualId, specHash: row.specHash } }, state => {
        if (!state.visualSpecs.some(item => item.id === visualId)) state.visualSpecs.push(row);
        const job = state.contentDirectorJobs.find(item => item.id === id);
        for (const artifact of row.artifacts) if (!job.artifacts.some(item => item.name === artifact.name && item.sha256 === artifact.sha256)) job.artifacts.push(artifact);
        job.visualSpecIds = [...new Set([...(job.visualSpecIds ?? []), visualId])];
        job.updatedAt = this.clock().toISOString();
        return row;
      });
      await this.#finishStep(id, renderStep, {
        output: { visualId, mime: "image/png", sha256: png.sha256, specHash: row.specHash },
        artifact: pngArtifact,
      });
      rows.push(row);
    }
    return rows;
  }

  async #processPureVisual(id) {
    if (!this.model) fail(503, "CONTENT_MODEL_UNAVAILABLE", "视觉生产线需要当前授权模型。");
    const job = this.state().contentDirectorJobs.find(row => row.id === id);
    const inputHash = hashObject(job.input);
    const step = await this.#beginStep(id, "visual.plan", `pure-visual:${inputHash}`, job.input);
    const result = await this.model.planVisuals(job.input);
    const plan = normalizeVisualPlan(result.value, { authorizedClaimIds: job.input.claimIds });
    const planArtifact = await this.#writeArtifact(id, `visual-plan-${hashObject(plan).slice(0, 12)}.json`, plan, "application/json");
    await this.#finishStep(id, step, { output: { visualCount: plan.visuals.length }, artifact: planArtifact, receipt: result.receipt });
    const visuals = [];
    for (const [index, spec] of plan.visuals.entries()) {
      const visualId = stableVisualId(id, index, hashObject(spec));
      const svg = renderVisualSvg(spec);
      const png = await renderVisualPng(spec);
      const rendered = await inspectRenderedVisual(png.bytes);
      const artifacts = [
        await this.#writeArtifact(id, `${visualId}.json`, { ...spec, mermaidSource: mermaidSource(spec) }, "application/json"),
        await this.#writeArtifact(id, `${visualId}.svg`, svg.bytes, "image/svg+xml"),
        await this.#writeArtifact(id, `${visualId}.png`, png.bytes, "image/png"),
      ];
      const visual = {
        id: visualId,
        jobId: id,
        index,
        spec,
        specHash: png.specHash,
        sourceHash: null,
        rendered,
        artifacts,
        createdAt: this.clock().toISOString(),
      };
      const persisted = this.state().visualSpecs.find(row => row.id === visualId && row.jobId === id);
      if (persisted) {
        visuals.push(persisted);
        continue;
      }
      await this.store.mutate({ type: "content_director.visual_created", actor: "content-director-worker", payload: { jobId: id, visualId, specHash: visual.specHash } }, state => {
        if (!state.visualSpecs.some(row => row.id === visualId)) state.visualSpecs.push(visual);
        return visual;
      });
      visuals.push(visual);
    }
    const resultPackage = {
      schema: "pengmanager.content-director-result/v1",
      jobId: id,
      artifactKind: "pure_visual",
      article: {
        title: plan.visuals[0]?.title ?? "视觉内容",
        summary: "",
        body: "",
        sections: [],
        blocks: [],
        claimIds: job.input.claimIds,
        language: job.input.language,
      },
      findings: [],
      visuals,
      contentHash: hashObject(visuals.map(row => ({ specHash: row.specHash, sourceHash: row.sourceHash }))),
      complete: true,
      frozenAt: this.clock().toISOString(),
    };
    const packageArtifact = await this.#writeArtifact(id, `content-package-${resultPackage.contentHash.slice(0, 12)}.json`, resultPackage, "application/json");
    const allArtifacts = [...visuals.flatMap(row => row.artifacts), packageArtifact];
    await this.store.mutate({ type: "content_director.visual_created", actor: "content-director-worker", payload: { jobId: id, visualIds: visuals.map(row => row.id) } }, next => {
      for (const visual of visuals) {
        if (!next.visualSpecs.some(row => row.id === visual.id)) next.visualSpecs.push(visual);
      }
      return null;
    });
    await this.#updateJob(id, {
      status: "needs_review",
      resultRef: packageArtifact,
      resultHash: resultPackage.contentHash,
      visualSpecIds: visuals.map(row => row.id),
      artifacts: allArtifacts,
      currentStep: "package.freeze",
    }, "content_director.visual_package_frozen");
  }

  async #processVideo(id) {
    const job = this.state().contentDirectorJobs.find(row => row.id === id);
    const step = await this.#beginStep(id, "video.plan", "video", job.input);
    let capabilities = null;
    let capabilityError = null;
    if (this.videoRuntime?.capabilities) {
      try {
        capabilities = await this.videoRuntime.capabilities();
      } catch (error) {
        capabilityError = error?.code ?? "VIDEO_CAPABILITIES_UNAVAILABLE";
      }
    }
    const handoff = createContentVideoHandoff(job, { capabilities });
    const plan = {
      schema: "pengmanager.content-video-plan/v1",
      artifactKind: job.artifactKind,
      durationSec: job.input.durationSec,
      platforms: job.input.platforms,
      route: job.route.videoSubroute ?? job.artifactKind.replace(/^video_/, ""),
      sourceAssets: job.input.attachments.filter(row => row.kind === "video"),
      handoff,
      nextActions: videoNextActions(job.artifactKind),
      capabilityError,
      productionVerified: false,
      generatedAt: this.clock().toISOString(),
    };
    const planArtifact = await this.#writeArtifact(id, `video-plan-${hashObject(plan).slice(0, 12)}.json`, plan, "application/json");
    await this.#finishStep(id, step, { output: plan, artifact: planArtifact });
    const handoffStep = await this.#beginStep(id, "video.handoff", handoff.handoffHash, handoff);
    const handoffArtifact = await this.#writeArtifact(id, `video-handoff-${handoff.handoffHash.slice(0, 12)}.json`, handoff, "application/json");
    await this.#finishStep(id, handoffStep, {
      output: {
        executorId: handoff.route.executorId,
        productionVerified: false,
        capabilityReady: handoff.capabilityState.ready,
      },
      artifact: handoffArtifact,
    });
    const result = {
      schema: "pengmanager.content-director-result/v1",
      jobId: id,
      artifactKind: job.artifactKind,
      article: null,
      videoPlan: plan,
      findings: [],
      visuals: [],
      contentHash: hashObject(plan),
      complete: false,
      frozenAt: this.clock().toISOString(),
    };
    const packageArtifact = await this.#writeArtifact(id, `content-package-${result.contentHash.slice(0, 12)}.json`, result, "application/json");
    const knownArtifacts = [
      ...job.artifacts,
      planArtifact,
      handoffArtifact,
      packageArtifact,
    ].filter((row, index, rows) => rows.findIndex(item => item.name === row.name && item.sha256 === row.sha256) === index);
    await this.#updateJob(id, {
      status: "needs_input",
      resultRef: packageArtifact,
      resultHash: result.contentHash,
      artifacts: knownArtifacts,
      missing: upsertMissing([
        ...(handoff.capabilityState.ready ? [] : ["本机视频运行时、模型与工具未就绪或未核实"]),
        "本机正式视频执行与单次预算授权",
        ...(job.artifactKind === "video_mixed" ? [] : []),
      ]),
      currentStep: "video.handoff",
    }, "content_director.video_planned");
  }

  async #writeArtifact(jobIdValue, name, value, mime) {
    if (!/^CDJ-[a-f0-9]{20}$/.test(jobIdValue)) fail(400, "CONTENT_ARTIFACT_INVALID", "Job 标识无效。");
    if (!ARTIFACT_NAME.test(name)) fail(400, "CONTENT_ARTIFACT_INVALID", "附件名称无效。");
    const root = await this.#ensureArtifactRoot();
    const directory = join(root, jobIdValue);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const realDirectory = await realpath(directory);
    if (!(realDirectory === join(root, jobIdValue)) || !realDirectory.startsWith(`${root}${sep}`)) {
      fail(500, "CONTENT_ARTIFACT_PATH_INVALID", "内容附件目录越界。");
    }
    const bytes = Buffer.isBuffer(value)
      ? value
      : typeof value === "string" && !mime.endsWith("json")
        ? Buffer.from(value, "utf8")
        : Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    const sha256 = bytesHash(bytes);
    const file = join(realDirectory, name);
    let handle;
    try {
      handle = await open(file, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await readFile(file);
      if (bytesHash(existing) !== sha256) fail(409, "CONTENT_ARTIFACT_CONFLICT", "同名附件已存在且字节不同。");
    } finally {
      await handle?.close();
    }
    return {
      id: `CDA-${sha256.slice(0, 24)}`,
      name,
      mime,
      bytes: bytes.length,
      sha256,
      createdAt: this.clock().toISOString(),
    };
  }

  async #ensureArtifactRoot() {
    if (this.#artifactRootReal) return this.#artifactRootReal;
    await mkdir(this.#artifactRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#artifactRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) fail(500, "CONTENT_ARTIFACT_ROOT_INVALID", "内容附件根目录不安全。");
    this.#artifactRootReal = await realpath(this.#artifactRoot);
    return this.#artifactRootReal;
  }

  async #ensureAttachmentRoot() {
    if (this.#attachmentRootReal) return this.#attachmentRootReal;
    const artifactRoot = await this.#ensureArtifactRoot();
    const root = join(artifactRoot, "attachments");
    const objects = join(root, "objects");
    const staging = join(root, "staging");
    for (const path of [root, objects, staging]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
        fail(503, "CONTENT_ATTACHMENT_STORAGE_UNSAFE", "内容附件目录不是当前用户私有的普通目录。");
      }
    }
    const real = await realpath(root);
    if (!real.startsWith(`${artifactRoot}${sep}`)) fail(503, "CONTENT_ATTACHMENT_STORAGE_UNSAFE", "内容附件目录越界。");
    this.#attachmentRootReal = real;
    return real;
  }
}

function buildArticleBlocks(sections) {
  const blocks = [];
  for (const section of sections) {
    blocks.push({ type: "heading", level: 2, text: section.title });
    for (const paragraph of section.paragraphs) blocks.push({ type: "paragraph", text: paragraph });
  }
  return blocks;
}

function deriveTags(brief) {
  const values = [brief.audience, brief.goal, ...brief.platforms];
  return [...new Set(values.map(value => String(value ?? "").trim()).filter(Boolean))].slice(0, 12);
}

function videoNextActions(kind) {
  if (kind === "video_ai") return [
    "使用本机 owner 标准视频 CLI 生成正式预览与项目",
    "按当前项目预算、审批和围栏提交逐镜渲染",
    "完成正式后期、媒体验证和交付回读",
  ];
  if (kind === "video_talking_head") return [
    "本机运行 ASR 与词级时间轴",
    "运行口播精剪和后期",
    "完整解码并人工试看",
  ];
  if (kind === "video_edit") return [
    "本机 probe 真实素材",
    "运行自动排片、时间轴校验和正式后期",
    "完整解码并人工试看",
  ];
  return [
    "建立逐镜头来源清单：AI、实拍、口播、图文卡",
    "在本机正式时间轴统一编排",
    "逐段核对来源、授权、时长和成片连续性",
  ];
}
