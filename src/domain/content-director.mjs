import { ApiError } from "./errors.mjs";
import { hashObject } from "./hash.mjs";
import { scanSensitiveText } from "./policy.mjs";

export const CONTENT_DIRECTOR_COLLECTIONS = Object.freeze([
  "contentDirectorJobs",
  "contentDirectorSteps",
  "contentBatches",
  "contentResearchBundles",
  "contentAuditReports",
  "visualSpecs",
  "contentDirectorRequests",
  "contentDirectorAttachments",
  "contentDirectorRevisions",
  "contentRepairAttempts",
  "contentPublishPackages",
]);

export const CONTENT_DIRECTOR_STATUSES = Object.freeze([
  "queued",
  "running",
  "needs_input",
  "needs_resume",
  "needs_review",
  "approved",
  "blocked",
  "failed",
  "unknown",
  "cancelled",
  "completed",
]);

export const CONTENT_STEP_STATUSES = Object.freeze([
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "needs_review",
]);

export const CONTENT_STEP_KINDS = Object.freeze([
  "route.resolve",
  "attachment.ingest",
  "brief.compile",
  "research.plan",
  "research.collect",
  "outline.generate",
  "outline.freeze",
  "section.research",
  "section.draft",
  "article.assemble",
  "quality.deterministic",
  "quality.review",
  "article.repair",
  "quality.final",
  "visual.plan",
  "visual.render",
  "video.plan",
  "video.handoff",
  "package.freeze",
  "edition.materialize",
  "content_ops.plan",
  "publication.status",
]);

export function initializeContentDirectorState(state) {
  for (const key of CONTENT_DIRECTOR_COLLECTIONS) {
    if (state[key] === undefined) state[key] = [];
    else if (!Array.isArray(state[key])) throw new ApiError(503, "CONTENT_DIRECTOR_STATE_INVALID", "内容总控集合结构无效。");
  }
  return state;
}

export function assertContentDirectorStateIntegrity(state) {
  if (![4].includes(state?.schemaVersion)) return;
  const invalid = () => { throw new ApiError(503, "CONTENT_DIRECTOR_STATE_INVALID", "内容总控状态完整性校验失败，停止启动并保留原文件。"); };
  if (!Array.isArray(state.migrations) || !state.migrations.some(row => row.id === "content-director-v1")) invalid();
  for (const key of CONTENT_DIRECTOR_COLLECTIONS) {
    if (!Array.isArray(state[key])) invalid();
    if (state[key].some(row => !row || typeof row !== "object" || Array.isArray(row))) invalid();
    const ids = state[key].filter(row => row.id !== undefined).map(row => row.id);
    if (new Set(ids).size !== ids.length) invalid();
  }
  const stepIds = new Set(state.contentDirectorSteps.map(row => row.id));
  const jobIds = new Set(state.contentDirectorJobs.map(row => row.id));
  for (const job of state.contentDirectorJobs) {
    if (typeof job.id !== "string" || !CONTENT_DIRECTOR_STATUSES.includes(job.status) ||
        !job.route || typeof job.route !== "object" || !Array.isArray(job.stepRefs) ||
        job.stepRefs.some(id => !stepIds.has(id))) invalid();
    if (job.batchId && !state.contentBatches.some(row => row.id === job.batchId)) invalid();
    if (!Array.isArray(job.artifacts) || new Set(job.artifacts.map(row => row.name)).size !== job.artifacts.length) invalid();
    if (job.visualSpecIds?.some(id => !state.visualSpecs.some(row => row.id === id))) invalid();
  }
  for (const step of state.contentDirectorSteps) {
    if (typeof step.id !== "string" || !jobIds.has(step.jobId) || !CONTENT_STEP_KINDS.includes(step.kind) ||
        !CONTENT_STEP_STATUSES.includes(step.status)) invalid();
  }
  const attachmentIds = new Set(state.contentDirectorAttachments.map(row => row.id));
  for (const row of state.contentDirectorAttachments) {
    if (typeof row.id !== "string" || !/^CDU-[a-f0-9]{32}$/.test(row.id) ||
        typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256) ||
        !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes !== row.size) invalid();
  }
  for (const job of state.contentDirectorJobs) {
    if (job.input?.attachments?.some(row => row.kind !== "url" && !attachmentIds.has(row.id))) invalid();
    if (job.route?.shotPlan?.some(row => row.attachmentId && !attachmentIds.has(row.attachmentId))) invalid();
  }
  for (const row of state.contentDirectorRevisions) {
    if (typeof row.id !== "string" || !jobIds.has(row.jobId) || typeof row.hash !== "string" ||
        typeof row.artifact?.name !== "string" || typeof row.artifact?.sha256 !== "string") invalid();
  }
  for (const row of state.contentRepairAttempts) {
    if (typeof row.id !== "string" || !jobIds.has(row.jobId) || !Number.isSafeInteger(row.round) || row.round < 1) invalid();
  }
  for (const row of state.contentPublishPackages) {
    if (typeof row.id !== "string" || !jobIds.has(row.jobId) || typeof row.packageHash !== "string" ||
        typeof row.artifact?.name !== "string") invalid();
  }
}

export function contentDirectorEtag(row) {
  const volatile = new Set(["etag", "updatedAt"]);
  if (typeof row?.id === "string" && row.id.startsWith("CDJ-")) {
    volatile.add("stepRefs");
    volatile.add("currentStep");
    volatile.add("artifacts");
  }
  const value = Object.fromEntries(Object.entries(row).filter(([key]) => !volatile.has(key)));
  return `"${hashObject(value)}"`;
}

export function contentDirectorEntity(row) {
  return { ...structuredClone(row), etag: contentDirectorEtag(row) };
}

export function normalizeArticleLength(value, fallback = {}) {
  const minCharacters = value?.minCharacters ?? fallback.minCharacters ?? 2000;
  const maxCharacters = value?.maxCharacters ?? fallback.maxCharacters ?? 4000;
  if (!Number.isSafeInteger(minCharacters) || !Number.isSafeInteger(maxCharacters) ||
      minCharacters < 500 || maxCharacters > 100_000 || minCharacters > maxCharacters) {
    throw new ApiError(400, "ARTICLE_LENGTH_INVALID", "文章目标长度必须是 500–100000 字符的有效区间。");
  }
  return { minCharacters, maxCharacters };
}

export function splitSectionsFromMarkdown(body) {
  const sections = [];
  let current = null;
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      current = { title: match[1], lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections.map((section, index) => {
    const text = section.lines.join("\n").trim();
    const paragraphs = text.split(/\n\s*\n/).map(row => row.trim()).filter(Boolean);
    return {
      index,
      title: section.title,
      body: text,
      paragraphs,
      charactersWithoutWhitespace: text.replace(/\s+/g, "").length,
    };
  });
}

export function deterministicArticleFindings(article, { minCharacters, maxCharacters, allowedUrls = [], mustKeep = [], mustAvoid = [] } = {}) {
  const findings = [];
  const body = String(article?.body ?? "");
  const sections = splitSectionsFromMarkdown(body);
  const characters = body.replace(/\s+/g, "").length;
  if (!article?.title?.trim()) findings.push({ severity: "blocker", code: "TITLE_REQUIRED", dimension: "structure", location: "title", message: "文章缺少标题。" });
  if (!body.trim()) findings.push({ severity: "blocker", code: "BODY_REQUIRED", dimension: "structure", location: "body", message: "文章正文为空。" });
  if (sections.length < 3) findings.push({ severity: "blocker", code: "SECTION_COUNT_TOO_LOW", dimension: "structure", location: "body", message: "完整长文至少需要三个二级章节。" });
  if (body.length > 100_000) findings.push({ severity: "blocker", code: "ARTICLE_BODY_LIMIT", dimension: "structure", location: "body", message: "正文超过 100000 字符上限。" });
  if (minCharacters && characters < minCharacters * 0.8) {
    findings.push({ severity: "blocker", code: "ARTICLE_TOO_SHORT", dimension: "structure", location: "body",
      message: `正文约 ${characters} 字符，低于目标下限的 80%（${Math.floor(minCharacters * 0.8)}）。` });
  }
  if (maxCharacters && characters > maxCharacters * 1.2) {
    findings.push({ severity: "major", code: "ARTICLE_TOO_LONG", dimension: "structure", location: "body",
      message: `正文约 ${characters} 字符，超过目标上限的 120%（${Math.ceil(maxCharacters * 1.2)}）。` });
  }
  for (const section of sections) {
    if (section.charactersWithoutWhitespace < 120) {
      findings.push({ severity: "blocker", code: "SECTION_TOO_SHORT", dimension: "structure", location: `section:${section.index}`,
        message: `章节「${section.title}」只有 ${section.charactersWithoutWhitespace} 个非空白字符。` });
    }
    if (section.paragraphs.length < 2) {
      findings.push({ severity: "blocker", code: "SECTION_PARAGRAPH_COUNT", dimension: "structure", location: `section:${section.index}`,
        message: `章节「${section.title}」必须至少包含两个实质段落。` });
    }
    const quantitative = /(?:\d+(?:\.\d+)?%|\d{4}年|\d+(?:\.\d+){1,3}|[$¥€£]\s?\d+|\b\d{2,}\b)/u.test(section.body);
    if (quantitative && !(article?.sections?.[section.index]?.claimIds?.length)) {
      findings.push({ severity: "blocker", code: "UNCITED_QUANTITATIVE_CLAIM", dimension: "facts", location: `section:${section.index}`,
        message: `章节「${section.title}」出现数字、版本、年份或金额，但没有绑定已批准 Claim 或研究来源。` });
    }
  }
  const headings = sections.map(section => section.title.replace(/\s+/g, "").toLowerCase());
  if (new Set(headings).size !== headings.length) {
    findings.push({ severity: "blocker", code: "DUPLICATE_SECTION_TITLE", dimension: "structure", location: "headings", message: "文章包含重复的二级章节标题。" });
  }
  const seen = new Map();
  for (const paragraph of body.split(/\n\s*\n/).map(row => row.replace(/\s+/g, "").trim()).filter(row => row.length >= 40)) {
    if (seen.has(paragraph)) {
      findings.push({ severity: "major", code: "DUPLICATE_PARAGRAPH", dimension: "expression", location: `paragraph:${seen.get(paragraph)}`,
        message: "文章出现完全重复的长段落。" });
    } else seen.set(paragraph, seen.size);
  }
  const filler = ["赋能", "颠覆世界", "行业第一", "AI大师", "毫无疑问", "众所周知", "革命性突破", "全链路闭环"];
  for (const term of filler) {
    if (body.includes(term)) findings.push({ severity: term === "行业第一" || term === "颠覆世界" ? "major" : "minor",
      code: "UNSUPPORTED_FILLER", dimension: "expression", location: term, message: `出现缺少证据或过度套话的表达「${term}」。` });
  }
  const permitted = new Set(allowedUrls.map(value => String(value)));
  for (const match of body.matchAll(/\bhttps?:\/\/[^\s)\]}>，。；;]+/giu)) {
    if (!permitted.has(match[0])) {
      findings.push({ severity: "blocker", code: "UNBOUND_URL", dimension: "facts", location: match.index,
        message: "正文包含没有进入 ResearchBundle 或 Claim 来源的链接。" });
    }
  }
  for (const value of scanSensitiveText(body)) {
    findings.push({ severity: "blocker", code: "SENSITIVE_CONTENT", dimension: "policy", location: "body",
      message: `正文包含敏感资料类型：${value}.` });
  }
  for (const value of mustKeep) {
    if (value && !body.includes(value)) {
      findings.push({ severity: "blocker", code: "MUST_KEEP_MISSING", dimension: "facts", location: "body",
        message: `正文没有保留用户要求逐字保留的内容：「${String(value).slice(0, 200)}」。` });
    }
  }
  for (const value of mustAvoid) {
    if (value && body.includes(value)) {
      findings.push({ severity: "blocker", code: "MUST_AVOID_PRESENT", dimension: "policy", location: "body",
        message: `正文出现了用户明确要求避免的内容：「${String(value).slice(0, 200)}」。` });
    }
  }
  return findings;
}

export function validateOutline(value, brief) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(502, "OUTLINE_INVALID", "模型没有返回有效提纲。");
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 240) throw new ApiError(502, "OUTLINE_INVALID", "提纲标题无效。");
  if (typeof value.summary !== "string" || value.summary.length > 2000) throw new ApiError(502, "OUTLINE_INVALID", "提纲摘要无效。");
  if (!Array.isArray(value.sections) || value.sections.length < 3 || value.sections.length > 20) throw new ApiError(502, "OUTLINE_INVALID", "提纲必须包含 3–20 个章节。");
  const keys = new Set();
  const titles = new Set();
  const claimIds = new Set(brief.claimIds ?? []);
  const sections = value.sections.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new ApiError(502, "OUTLINE_INVALID", "章节必须为对象。");
    const key = String(row.key ?? `section-${index + 1}`).trim();
    const title = String(row.title ?? "").trim();
    const purpose = String(row.purpose ?? "").trim();
    const targetCharacters = Number(row.targetCharacters ?? Math.round((brief.targetLength.minCharacters + brief.targetLength.maxCharacters) / 2 / value.sections.length));
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(key) || keys.has(key) || !title || title.length > 240 || !purpose || purpose.length > 2000 ||
        !Number.isSafeInteger(targetCharacters) || targetCharacters < 120 || targetCharacters > 20_000) {
      throw new ApiError(502, "OUTLINE_INVALID", "提纲章节字段无效或重复。");
    }
    const normalizedTitle = title.replace(/\s+/g, "").toLowerCase();
    if (titles.has(normalizedTitle)) throw new ApiError(502, "OUTLINE_INVALID", "提纲章节标题不得重复。");
    if (scanSensitiveText(`${title}\n${purpose}`).length) throw new ApiError(422, "OUTLINE_SENSITIVE", "提纲包含个人敏感资料或凭据。");
    keys.add(key);
    titles.add(normalizedTitle);
    const sectionClaims = Array.isArray(row.claimIds) ? [...new Set(row.claimIds.map(String))] : [];
    if (sectionClaims.some(id => !claimIds.has(id))) throw new ApiError(502, "OUTLINE_INVALID", "提纲引用了任务未授权的 Claim。");
    return { key, title, purpose, targetCharacters, claimIds: sectionClaims };
  });
  const total = sections.reduce((sum, row) => sum + row.targetCharacters, 0);
  if (total < brief.targetLength.minCharacters * 0.8) throw new ApiError(502, "OUTLINE_INVALID", "各章节目标字数不足以达到全文下限。");
  return { title: value.title.trim(), summary: value.summary.trim(), sections };
}

export function validateSectionDraft(value, section, authorizedClaimIds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(502, "SECTION_DRAFT_INVALID", "模型没有返回有效章节。");
  const title = String(value.title ?? section.title).trim();
  const body = String(value.body ?? "").trim();
  const paragraphs = Array.isArray(value.paragraphs)
    ? value.paragraphs.map(item => String(item).trim()).filter(Boolean)
    : body.split(/\n\s*\n/).map(item => item.trim()).filter(Boolean);
  const claimIds = Array.isArray(value.claimIds) ? [...new Set(value.claimIds.map(String))] : (section.claimIds ?? []);
  if (!title || title.length > 240 || !body || body.length > 50_000 || paragraphs.length < 2 ||
      paragraphs.some(row => row.length > 20_000) || claimIds.some(id => !authorizedClaimIds.has(id))) {
    throw new ApiError(502, "SECTION_DRAFT_INVALID", "章节标题、完整正文、段落或 Claim 引用无效。");
  }
  if (scanSensitiveText(`${title}\n${body}`).length) {
    throw new ApiError(422, "SECTION_SENSITIVE", "章节包含个人敏感资料或凭据。");
  }
  return { key: section.key, title, body: paragraphs.join("\n\n"), paragraphs, claimIds };
}

export function composeArticleBody(sections, { includeIntro = true } = {}) {
  if (!Array.isArray(sections) || sections.length === 0) throw new ApiError(400, "ARTICLE_SECTIONS_REQUIRED", "文章缺少章节。");
  void includeIntro;
  return sections.map(section => `## ${section.title}\n\n${section.body}`).join("\n\n");
}

export function updateContentDirectorStep(state, stepId, patch) {
  const step = state.contentDirectorSteps.find(row => row.id === stepId);
  if (!step) throw new ApiError(404, "CONTENT_STEP_NOT_FOUND", "找不到内容步骤。");
  Object.assign(step, patch, { updatedAt: new Date().toISOString() });
  return step;
}
