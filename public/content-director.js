// Content Director browser projection. All state comes from authenticated APIs.
import { escapeHtml as html, safePublicUrl } from "./publication-view.js";

const STATUS_LABELS = {
  queued: "排队中",
  running: "正在执行",
  needs_input: "待补输入",
  needs_resume: "待恢复",
  needs_review: "待人工审核",
  approved: "已批准",
  blocked: "质量阻断",
  failed: "执行失败",
  unknown: "结果未知",
  cancelled: "已取消",
  completed: "已物化",
};

const ARTIFACT_LABELS = {
  article: "文章",
  article_visual: "文章 + 配图",
  pure_visual: "纯图片 / 信息图",
  video_ai: "AI 视频",
  video_edit: "实拍剪辑",
  video_talking_head: "口播精剪",
  video_mixed: "混合视频",
};

const STEP_LABELS = {
  "route.resolve": "识别内容类型",
  "attachment.ingest": "核对真实附件",
  "brief.compile": "编译创作 Brief",
  "research.plan": "制定研究计划",
  "research.collect": "收集来源",
  "outline.generate": "生成提纲",
  "outline.freeze": "冻结提纲",
  "section.research": "绑定本节证据",
  "section.draft": "逐节写作",
  "article.assemble": "合并全文",
  "quality.deterministic": "结构与完整性检查",
  "quality.review": "独立审阅",
  "article.repair": "定点修复",
  "quality.final": "最终独立审核",
  "visual.plan": "规划配图",
  "visual.render": "渲染图表",
  "video.plan": "规划视频生产",
  "video.handoff": "生成原生视频 handoff",
  "package.freeze": "冻结交付包",
  "edition.materialize": "物化不可变 Edition",
  "content_ops.plan": "建立内容运营计划",
};

function key() {
  if (!globalThis.crypto?.randomUUID) throw new Error("当前页面无法生成安全请求标识，请使用 HTTPS 管理后台。");
  return crypto.randomUUID();
}

function time(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "未记录";
}

function status(value, label = STATUS_LABELS[value] || value) {
  return `<span class="cd-status" data-status="${html(value)}">${html(label)}</span>`;
}

function activeVisualGate(job) {
  return job?.visualGate?.approvalEligible === false ? job.visualGate : null;
}

function jobStatus(job) {
  return activeVisualGate(job) && !["cancelled", "completed"].includes(job.status)
    ? status("needs_input", "待配图核验")
    : status(job.status);
}

function list(values = []) {
  return values.length ? `<ul class="cd-list">${values.map(value => `<li>${html(value)}</li>`).join("")}</ul>` : "";
}

function artifactUrl(jobId, name) {
  return `/api/content-director/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(name)}`;
}

function lengthInput(fields) {
  const minCharacters = fields.get("minCharacters");
  const maxCharacters = fields.get("maxCharacters");
  if (!minCharacters && !maxCharacters) return {};
  return {
    targetLength: {
      ...(minCharacters ? { minCharacters: Number(minCharacters) } : {}),
      ...(maxCharacters ? { maxCharacters: Number(maxCharacters) } : {}),
    },
  };
}

function attachmentRole(file) {
  const name = String(file.name || "").toLowerCase();
  const mime = String(file.type || "").toLowerCase().split(";", 1)[0];
  if (mime.startsWith("image/")) return "image";
  if (mime === "video/mp4") return "video";
  if (mime === "audio/wav") return "audio";
  if (mime === "text/vtt" || /\.(?:vtt|srt|ass)$/.test(name)) return "transcript";
  if (mime === "text/csv" || mime === "application/json" || /\.(?:csv|json)$/.test(name)) return "data";
  if (/\.(?:py|js|mjs|ts|tsx|jsx|diff|patch|zip)$/.test(name) || ["text/javascript", "text/x-python", "text/x-diff"].includes(mime)) return "code";
  return "document";
}

function uploadMime(file) {
  const name = String(file.name || "").toLowerCase();
  if (file.type) return file.type.split(";", 1)[0];
  if (name.endsWith(".md")) return "text/markdown";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".csv")) return "text/csv";
  if (name.endsWith(".vtt")) return "text/vtt";
  if (name.endsWith(".srt")) return "application/x-subrip";
  if (name.endsWith(".ass")) return "text/x-ass";
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".zip")) return "application/zip";
  if (name.endsWith(".py")) return "text/x-python";
  if (/\.(?:js|mjs)$/.test(name)) return "text/javascript";
  return "text/plain";
}

export function mountContentDirector({ api, getData, showError } = {}) {
  const root = document.querySelector("#content-director-root");
  if (!root) return { async load() {}, render() {} };
  const state = {
    jobs: [],
    batches: [],
    metrics: null,
    serviceStatus: null,
    context: null,
    publication: null,
    selectedJob: null,
    preview: null,
    pendingInput: null,
    uploadedAttachments: [],
    illustrationAttempt: null,
    loading: false,
    busy: false,
    error: null,
    notice: "",
  };

  const claims = () => getData()?.claims ?? [];
  const claimChecks = () => claims().map(claim => `<label class="cd-check"><input type="checkbox" name="claimIds" value="${html(claim.id)}" /><span><strong>${html(claim.id)}</strong> ${html(claim.text)} <small>${claim.state === "approved" ? "已批准" : "待审批"}</small></span></label>`).join("");
  const options = () => Object.entries(ARTIFACT_LABELS).map(([value, label]) => `<option value="${html(value)}">${html(label)}</option>`).join("");

  async function sha256(file) {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
  }

  async function uploadFile(file, { speechLikely = false } = {}) {
    const role = attachmentRole(file), mime = uploadMime(file);
    const response = await fetch("/api/content-director/attachments", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": mime,
        "X-Artifact-Role": role,
        "X-Content-Size": String(file.size),
        "X-Content-Sha256": await sha256(file),
        "X-Artifact-Name": encodeURIComponent(file.name),
        "X-Speech-Likely": speechLikely ? "true" : "false",
        "Idempotency-Key": key(),
      },
      body: file,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error?.message || `附件 ${file.name} 上传失败。`);
      error.code = payload.error?.code;
      throw error;
    }
    return { ...payload, localName: file.name };
  }

  function formMarkup() {
    return `<article class="cd-panel cd-create-panel">
      <div class="cd-panel-heading"><div><p class="cd-eyebrow">One intent · correct pipeline</p><h3>从一句意图开始</h3></div><span>路由只决定生产线，不代表发布授权</span></div>
      <form data-cd-form="single">
        <label class="cd-wide"><span>主题、观点、想法或任务</span><textarea name="intent" required rows="7" maxlength="20000" placeholder="例如：写一篇记录小院日常的随笔，并配三张应景照片。"></textarea></label>
        <div class="cd-grid">
          <label><span>内容类型</span><select name="explicitKind"><option value="">自动识别（推荐）</option>${options()}</select></label>
          <label><span>目标平台</span><input name="platforms" maxlength="500" placeholder="官网, 掘金, 微信公众号" /></label>
          <label><span>最小字数</span><input name="minCharacters" type="number" min="500" max="100000" placeholder="按文风自动" /></label>
          <label><span>最大字数</span><input name="maxCharacters" type="number" min="500" max="100000" placeholder="按文风自动" /></label>
          <label><span>视频总时长（秒）</span><input name="durationSec" type="number" min="5" max="180" placeholder="视频任务填写" /></label>
          <label><span>文章语言</span><select name="language"><option value="zh-CN">中文</option><option value="en-US">English</option></select></label>
        </div>
        <label class="cd-wide"><span>我的思考、必须保留的判断和表达</span><textarea name="authorThoughts" rows="4" maxlength="20000" placeholder="每行一条。系统可以组织，但不能改掉你的中心思想或补造亲历。"></textarea></label>
        <label class="cd-wide"><span>上传真实材料</span><input name="attachments" type="file" multiple /><small class="cd-muted">支持文本、Markdown、JSON、CSV、代码、VTT、PDF、PNG/JPEG/WebP、MP4 与 PCM WAV；上传后显示实际 SHA-256 回执。</small></label>
        ${state.uploadedAttachments.length ? `<section class="cd-upload-receipts"><strong>已核对附件</strong>${state.uploadedAttachments.map(row => `<span>${html(row.localName || row.name)} · ${html(row.kind)} · ${html(row.sha256.slice(0, 12))}…</span>`).join("")}</section>` : ""}
        <div class="cd-grid">
          <label class="cd-check cd-inline"><input name="allowWebResearch" type="checkbox" /><span><strong>允许联网研究</strong><br />未勾选时只使用我的材料、上传资料和已批准 Claim。</span></label>
          <label class="cd-check cd-inline"><input name="videoRightsConfirmed" type="checkbox" /><span><strong>已核对真实素材授权</strong><br />实拍、口播、混合视频启动前必须完成。</span></label>
        </div>
        <label class="cd-wide"><span>混合视频逐镜头来源清单（JSON，可选）</span><textarea name="shotPlan" rows="5" maxlength="20000" placeholder='[{"sourceType":"real_footage","durationSec":15,"attachmentId":"CDU-…","authorizationId":"AUTH-…"},{"sourceType":"ai_generated","durationSec":15,"description":"产品机制动画"}]'></textarea></label>
        <fieldset class="cd-claims"><legend>本次允许使用的事实 Claim</legend>${claimChecks() || "<p>当前没有 Claim。</p>"}</fieldset>
        <div class="cd-actions"><button class="primary-button" type="submit" ${state.serviceStatus?.writable === false ? "disabled" : ""}>识别并创建任务</button><button class="ghost-button" type="button" data-cd-resolve>${state.serviceStatus?.writable === false ? "查看 shadow 路由" : "只识别内容类型"}</button></div>
      </form>
      <div data-cd-preview>${previewMarkup()}</div>
    </article>
    <details class="cd-panel"><summary><strong>批量主题</strong> · 每个主题建立独立 Job，失败互不影响</summary>
      <form data-cd-form="batch">
        <label><span>批次名称</span><input name="batchName" maxlength="240" value="内容批次" /></label>
        <label><span>主题列表（每行一个）</span><textarea name="topics" required rows="8" maxlength="20000" placeholder="每个主题单独一行"></textarea></label>
        <label><span>共享目标平台</span><input name="platforms" maxlength="500" placeholder="官网, 知乎, 掘金" /></label>
        <div class="cd-grid"><label><span>最小字数</span><input name="minCharacters" type="number" min="500" max="100000" placeholder="按文风自动" /></label><label><span>最大字数</span><input name="maxCharacters" type="number" min="500" max="100000" placeholder="按文风自动" /></label></div>
        <label class="cd-check cd-inline"><input name="allowWebResearch" type="checkbox" /><span>允许联网研究</span></label>
        <button class="primary-button" type="submit">建立独立文章 Job</button>
      </form>
    </details>`;
  }

  function previewMarkup() {
    if (!state.preview) return "";
    const p = state.preview;
    const visualLabel = p.articleIllustrations
      ? `至少 ${p.articleIllustrations.minimum} 张正文配图${p.visualForm?.kinds?.length ? "，另含指定技术图" : ""}`
      : p.enableVisuals ? "生成" : "不生成";
    const lengthLabel = p.targetLength
      ? `<div><dt>正文目标</dt><dd>${html(p.targetLength.minCharacters)}–${html(p.targetLength.maxCharacters)} 字符</dd></div>`
      : "";
    return `<section class="cd-route-preview"><div><p class="cd-eyebrow">执行确认卡</p><h4>${html(ARTIFACT_LABELS[p.artifactKind] || "需要澄清")}</h4></div><dl><div><dt>生产线</dt><dd>${html(p.pipeline || "—")}</dd></div>${lengthLabel}<div><dt>置信度</dt><dd>${Math.round(Number(p.confidence || 0) * 100)}%</dd></div><div><dt>联网</dt><dd>${p.allowWebResearch ? "允许" : "仅本地材料"}</dd></div><div><dt>配图</dt><dd>${html(visualLabel)}</dd></div><div><dt>附件</dt><dd>${p.attachments?.length ?? 0}</dd></div><div><dt>费用等级</dt><dd>${html(p.costClass || "未估算")}</dd></div></dl><p>${html(p.rationale || p.clarifyQuestion || "")}</p>${list(p.missing ?? [])}${p.artifactKind && state.pendingInput ? `<div class="cd-actions">${state.serviceStatus?.writable === false ? "" : `<button class="primary-button" type="button" data-cd-create-confirmed>按此路由创建任务</button>`}<button class="ghost-button" type="button" data-cd-clear-preview>取消</button></div>` : ""}<p class="cd-muted">确认只表示建立 Job；事实、预算、视频生成和发布仍需分别授权。</p></section>`;
  }

  function illustrationRequest(job) {
    const request = job.editorialIllustration;
    if (request?.status !== "waiting_for_images") return "";
    const sections = job.articleDraft?.article?.sections ?? [];
    return `<section class="cd-result"><h4>正文配图</h4>
      <p>为这份初审正文准备至少 ${html(request.minImages)} 张应景图片。图片须对应下列章节，并附来源、使用权和逐张审阅记录。</p>
      <dl><dt>配图请求</dt><dd><code>${html(request.requestId)}</code></dd>
      <dt>正文 SHA-256</dt><dd><code style="overflow-wrap:anywhere">${html(request.draftHash)}</code></dd></dl>
      ${list(sections.map(section => `${section.title || section.heading || section.key} · ${section.key}`))}
      <form data-cd-form="illustrations">
        <label><span>配图回执 ID</span><input name="receiptId" required pattern="AIR-[a-f0-9]{24}" maxlength="28" placeholder="AIR-…" value="${html(state.illustrationAttempt?.jobId === job.id ? state.illustrationAttempt.receiptId : "")}" /></label>
        <div class="cd-actions"><button class="primary-button" type="submit">绑定图片并进入终审</button></div>
      </form>
    </section>`;
  }

  function jobDetail() {
    const job = state.selectedJob;
    if (!job) return `<div class="cd-empty"><strong>请选择一个内容 Job</strong><p>阶段、输入、预算状态、审核问题和产物都从真实账本读取。</p></div>`;
    const result = job.result;
    const visualGate = activeVisualGate(job);
    const article = result?.article ?? job.articleDraft?.article;
    const missing = (job.missing ?? []).filter(value => value !== visualGate?.message);
    const steps = [...(job.steps ?? [])].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const reports = job.reports ?? [];
    const destinations = state.context?.contentOps?.destinations ?? [];
    const nativeForm = job.artifactKind === "pure_visual" ? "image_text" : job.artifactKind?.startsWith("video_") ? "video" : "article";
    return `<article class="cd-panel cd-job-detail">
      <div class="cd-panel-heading"><div><p class="cd-eyebrow">${html(job.id)} · ${html(ARTIFACT_LABELS[job.artifactKind] || job.artifactKind)}</p><h3>${html(article?.title || job.input?.intent?.slice(0, 120) || "内容 Job")}</h3></div>${jobStatus(job)}</div>
      <div class="cd-job-meta"><span>${html(job.pipeline)}</span><span>${html(time(job.updatedAt))}</span><span>${html(job.currentStep || "—")}</span></div>
      ${job.error ? `<p class="cd-error" role="alert">${html(job.error.code)} · ${html(job.error.message)}</p>` : ""}
      ${visualGate ? `<section class="cd-warning" role="status" data-cd-visual-gate><strong>待配图核验</strong><p>${html(visualGate.message)}</p>${result ? `<small>历史任务状态 ${html(STATUS_LABELS[job.status] || job.status)}</small>` : ""}</section>` : ""}
      ${missing.length ? `<section class="cd-warning"><strong>待补输入</strong>${list(missing)}</section>` : ""}
      <ol class="cd-steps">${steps.map(step => `<li data-state="${html(step.status)}"><strong>${html(STEP_LABELS[step.kind] || step.kind)}</strong><span>${html(step.status)}</span>${step.error ? `<p>${html(step.error.code)} · ${html(step.error.message)}</p>` : ""}${step.output ? `<details><summary>查看阶段回执</summary><pre>${html(JSON.stringify(step.output, null, 2))}</pre></details>` : ""}</li>`).join("")}</ol>
      ${article?.body ? `<section class="cd-result"><h4>${result?.article ? "完整正文" : "已冻结的初审正文"}</h4><pre class="cd-article-body">${html(article.body)}</pre></section>` : ""}
      ${illustrationRequest(job)}
      ${job.visualSpecs?.length ? `<section class="cd-visuals"><h4>${visualGate ? "历史视觉附件" : "正文配图与图表"}</h4>${job.visualSpecs.map(spec => {
        const editable = spec.spec.kind !== "editorial_illustration";
        const png = spec.artifacts.find(item => ["image/png", "image/jpeg"].includes(item.mime));
        const svg = spec.artifacts.find(item => item.mime === "image/svg+xml");
        const source = spec.artifacts.find(item => item.mime === "application/json");
        const attribution = spec.production?.provenance?.source?.attribution;
        const original = safePublicUrl(attribution?.landingUrl, { relative: false });
        const license = safePublicUrl(attribution?.licenseUrl, { relative: false });
        const credit = original && license ? `<p>照片署名 · ${html(attribution.credit)} · <a class="text-link" href="${html(original)}" target="_blank" rel="noopener noreferrer">原图</a> · <a class="text-link" href="${html(license)}" target="_blank" rel="noopener noreferrer">${html(attribution.licenseId)}</a> · ${html(attribution.modifications)}</p>` : "";
        return `<article><h5>${html(spec.spec.title)}</h5>${png ? `<img src="${html(artifactUrl(job.id, png.name))}" alt="${html(spec.spec.alt)}" />` : ""}<div class="cd-actions">${svg ? `<a class="text-link" href="${html(artifactUrl(job.id, svg.name))}" target="_blank" rel="noreferrer">打开 SVG</a>` : ""}${source ? `<a class="text-link" href="${html(artifactUrl(job.id, source.name))}" target="_blank" rel="noreferrer">查看图源</a>` : ""}${editable && !job.visualSpecs.some(item => item.spec.kind === "editorial_illustration") && !visualGate && ["needs_review", "blocked", "approved"].includes(job.status) ? `<button class="ghost-button" type="button" data-cd-visual-up="${html(spec.id)}">前移</button><button class="ghost-button" type="button" data-cd-visual-down="${html(spec.id)}">后移</button>` : ""}</div><p>${html(spec.spec.caption || "")}</p>${credit}</article>`;
      }).join("")}</section>` : ""}
      ${job.result?.videoPlan ? `<section class="cd-result"><h4>视频生产计划</h4><div class="cd-plan-grid"><article><span>执行器</span><strong>${html(job.result.videoPlan.handoff?.route?.executorId || "未确定")}</strong></article><article><span>目标时长</span><strong>${html(job.result.videoPlan.durationSec || "—")} 秒</strong></article><article><span>原生运行时</span><strong>${html(job.result.videoPlan.handoff?.capabilityState?.state || "unverified")}</strong></article><article><span>正式成片</span><strong>${job.result.videoPlan.productionVerified ? "已回读" : "未产生"}</strong></article></div><p>${list(job.result.videoPlan.handoff?.capabilityState?.relevantMissing ?? [])}</p><ol class="cd-list">${(job.result.videoPlan.nextActions ?? []).map(value => `<li>${html(value)}</li>`).join("")}</ol><details><summary>查看完整原生 handoff JSON</summary><pre>${html(JSON.stringify(job.result.videoPlan, null, 2))}</pre></details></section>` : ""}
      ${reports.length ? `<details class="cd-result"><summary><strong>${visualGate ? "历史审核报告" : "审核报告"}</strong> · ${reports.length}</summary>${reports.map(report => `<article class="cd-report"><h5>${html(report.phase)} · ${html(time(report.generatedAt))}</h5><p>${html(report.assessment || "")}</p><small>blocker ${html((report.findings || []).filter(row => row.severity === "blocker").length)} · major ${html((report.findings || []).filter(row => row.severity === "major").length)}</small></article>`).join("")}</details>` : ""}
      ${job.findings?.length ? `<section class="cd-findings"><h4>审核问题</h4>${job.findings.map(f => `<article data-severity="${html(f.severity)}"><strong>${html(f.severity)} · ${html(f.code)}</strong><p>${html(f.message)}</p><small>${html(f.dimension)} · ${html(f.location)}</small></article>`).join("")}</section>` : visualGate ? "" : `<p class="cd-notice">当前没有审核 finding。仍须人工阅读完整结果。</p>`}
      ${!visualGate && job.status === "completed" ? `<section class="cd-panel"><h4>内容运营与发布交接</h4>${destinations.length ? `<p>选择真实目的地，生成“准备适配”计划。计划不会自动外发。</p>${destinations.filter(row => row.nativeForm === nativeForm || !row.nativeForm).slice(0, 40).map(row => `<label class="cd-check cd-inline"><input type="checkbox" data-cd-ops-destination value="${html(row.id)}" /><span><strong>${html(row.platformId)} · ${html(row.locator || row.kind || row.id)}</strong><small>${html(row.id)} · ${html(row.visibility || "未标可见范围")}</small></span></label>`).join("")}<div class="cd-actions"><button class="primary-button" type="button" data-cd-action="content-ops">建立平台适配计划</button></div>` : `<p class="cd-warning">还没有可用于该原生形式的目的地。请先在“编辑出版”登记真实目的地和当次平台规则。</p>`}</section>` : ""}
      ${job.contentOpsPlan ? `<section class="cd-result"><h4>平台适配计划</h4><p>${html(job.contentOpsPlan.packageHash)} · gaps ${html(job.contentOpsPlan.gaps?.length || 0)}</p>${list((job.contentOpsPlan.gaps || []).map(gap => `${gap.code} · ${gap.explanation || gap.inputKey}`))}</section>` : ""}
      ${state.publication?.jobId === job.id ? `<section class="cd-result"><h4>发布状态</h4><pre>${html(JSON.stringify(state.publication.statuses, null, 2))}</pre><p>公开页面已发布：${state.publication.statuses?.publicSitePublished ? "是（真实回读）" : "否"}；外部平台已发布：${state.publication.statuses?.externalPlatformPublished ? "是（真实回执）" : "否"}。</p></section>` : ""}
      <div class="cd-actions">
        ${["queued", "running"].includes(job.status) ? `<button class="ghost-button" type="button" data-cd-action="pause">请求暂停</button>` : ""}
        ${!visualGate && job.status === "needs_resume" && !job.missing?.length ? `<button class="primary-button" type="button" data-cd-action="resume">继续执行</button>` : ""}
        ${!visualGate && ["failed", "blocked"].includes(job.status) && !job.missing?.length ? `<button class="primary-button" type="button" data-cd-action="repair">按现有 finding 重试</button>` : ""}
        ${["queued", "running", "needs_resume", "needs_input", "blocked", "failed"].includes(job.status) ? `<button class="ghost-button" type="button" data-cd-action="cancel">取消</button>` : ""}
        ${["approved", "completed"].includes(job.status) ? `<button class="ghost-button" type="button" data-cd-action="publication">读取发布状态</button>` : ""}
        ${!visualGate && job.status === "needs_review" && result ? `<label class="cd-check cd-inline"><input data-cd-approved type="checkbox" /><span>我已阅读完整正文、全部图表与审核问题</span></label><button class="primary-button" type="button" data-cd-action="approve">批准当前完整快照</button>` : ""}
        ${!visualGate && job.status === "approved" && job.result?.visuals?.length ? `<label class="cd-wide"><span>视觉素材权利与隐私核对依据</span><textarea data-cd-visual-note rows="2" maxlength="2000" placeholder="记录本次对生成图、图源、字体和事实内容的实际核对。"></textarea></label><label class="cd-check cd-inline"><input data-cd-visual-rights type="checkbox" /><span>我已核对全部图表的内容、来源、版权与隐私，可用于当前内容。</span></label>` : ""}
        ${!visualGate && job.status === "approved" ? `<button class="primary-button" type="button" data-cd-action="materialize">建立不可变 Edition</button>` : ""}
      </div>
    </article>`;
  }

  function render() {
    if (state.serviceStatus?.enabled === false) {
      root.innerHTML = `<div class="cd-empty"><strong>创作总控当前已关闭</strong><p>功能开关只停止新入口，旧编辑出版、内容运营师和视频入口继续可用；历史 Job 与私有证据不会删除。</p><p>当前模式：${html(state.serviceStatus.mode)}</p></div>`;
      return;
    }
    const metrics = state.metrics;
    root.innerHTML = `<div class="cd-workspace">${formMarkup()}
      ${metrics ? `<section class="cd-metrics"><article><span>内容 Job</span><strong>${html(metrics.jobs?.total ?? 0)}</strong><small>${html(Object.entries(metrics.jobs?.byStatus || {}).filter(([, count]) => count).map(([name, count]) => `${STATUS_LABELS[name] || name} ${count}`).join(" · "))}</small></article><article><span>平均路由置信度</span><strong>${metrics.routing?.averageConfidence == null ? "无样本" : `${Math.round(metrics.routing.averageConfidence * 100)}%`}</strong><small>显式类型直接锁定，模糊意图才调用模型。</small></article><article><span>首次质量通过率</span><strong>${metrics.article?.firstPassQualityRate == null ? "无样本" : `${Math.round(metrics.article.firstPassQualityRate * 100)}%`}</strong><small>blocker ${html(metrics.article?.openBlockers ?? 0)} · major ${html(metrics.article?.openMajors ?? 0)}</small></article><article><span>图表 PNG 成功率</span><strong>${metrics.visual?.pngSuccessRate == null ? "无样本" : `${Math.round(metrics.visual.pngSuccessRate * 100)}%`}</strong><small>${html(metrics.visual?.active ?? 0)} 张当前有效图 · ${html(metrics.evidence?.researchSources ?? 0)} 条研究来源</small></article></section>` : ""}
      <div class="cd-panel-heading cd-jobs-heading"><div><p class="cd-eyebrow">Persistent jobs</p><h3>内容任务</h3></div><button class="ghost-button" type="button" data-cd-refresh>刷新</button></div>
      <div class="cd-layout"><section class="cd-jobs" aria-label="内容任务列表">${state.jobs.length ? state.jobs.map(job => `<button type="button" data-cd-job="${html(job.id)}" data-active="${job.id === state.selectedJob?.id}"><strong>${html(job.input?.intent?.slice(0, 60) || job.id)}</strong><span>${html(ARTIFACT_LABELS[job.artifactKind] || job.artifactKind)} · ${html(time(job.updatedAt))}</span>${jobStatus(job.id === state.selectedJob?.id ? state.selectedJob : job)}</button>`).join("") : `<div class="cd-empty"><strong>还没有内容 Job</strong><p>从上面的输入创建第一条。</p></div>`}</section><section>${jobDetail()}</section></div>
      <details class="cd-panel"><summary><strong>批次状态</strong> · 只汇总真实 Job 状态</summary>${state.batches.length ? state.batches.map(batch => `<article class="cd-batch"><h4>${html(batch.name)}</h4><p>${html(batch.id)} · ${html(time(batch.updatedAt))}</p><div class="cd-batch-counts">${Object.entries(batch.counts || {}).filter(([, count]) => count).map(([name, count]) => `<span>${html(STATUS_LABELS[name] || name)} ${html(count)}</span>`).join("")}</div><div class="cd-actions"><button class="ghost-button" type="button" data-cd-batch="pause" data-cd-batch-id="${html(batch.id)}">暂停</button><button class="primary-button" type="button" data-cd-batch="resume" data-cd-batch-id="${html(batch.id)}">继续</button><button class="ghost-button" type="button" data-cd-batch="cancel" data-cd-batch-id="${html(batch.id)}">取消</button></div></article>`).join("") : `<p>没有批次。</p>`}</details>
      ${state.error ? `<p class="cd-error" role="alert">${html(state.error)}</p>` : ""}
      ${state.notice ? `<p class="cd-notice" role="status">${html(state.notice)}</p>` : ""}
    </div>`;
  }

  async function load() {
    state.loading = true;
    state.error = null;
    try {
      state.serviceStatus = await api("/api/content-director/status");
      if (state.serviceStatus.enabled === false) {
        render();
        return;
      }
      const [jobs, batches, metrics] = await Promise.all([
        api("/api/content-director/jobs"),
        api("/api/content-director/batches"),
        api("/api/content-director/metrics"),
      ]);
      state.jobs = jobs.items ?? [];
      state.batches = batches.items ?? [];
      state.metrics = metrics;
      if (state.selectedJob) state.selectedJob = await api(`/api/content-director/jobs/${encodeURIComponent(state.selectedJob.id)}`);
      else if (state.jobs[0]) state.selectedJob = await api(`/api/content-director/jobs/${encodeURIComponent(state.jobs[0].id)}`);
      state.context = state.selectedJob
        ? await api(`/api/content-director/jobs/${encodeURIComponent(state.selectedJob.id)}/context`)
        : null;
      if (state.publication?.jobId !== state.selectedJob?.id) state.publication = null;
    } catch (error) {
      state.error = error.message || "读取内容任务失败。";
      if (showError) showError(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  function formInput(form, uploaded = state.uploadedAttachments) {
    const fields = new FormData(form);
    const platforms = String(fields.get("platforms") || "").split(/[,，]/).map(value => value.trim()).filter(Boolean);
    const shotSource = String(fields.get("shotPlan") || "").trim();
    let shotPlan;
    if (shotSource) {
      try { shotPlan = JSON.parse(shotSource); }
      catch { throw new Error("混合镜表必须是合法 JSON。"); }
    }
    return {
      intent: fields.get("intent"),
      ...(fields.get("explicitKind") ? { explicitKind: fields.get("explicitKind") } : {}),
      platforms,
      ...lengthInput(fields),
      ...(Number(fields.get("durationSec")) ? { durationSec: Number(fields.get("durationSec")) } : {}),
      language: fields.get("language"),
      authorThoughts: String(fields.get("authorThoughts") || "").split(/\n/).map(value => value.trim()).filter(Boolean),
      allowWebResearch: fields.get("allowWebResearch") === "on",
      claimIds: fields.getAll("claimIds"),
      videoRightsConfirmed: fields.get("videoRightsConfirmed") === "on",
      attachments: uploaded.map(row => ({
        kind: row.kind,
        id: row.id,
        mime: row.mime,
        name: row.name,
        sha256: row.sha256,
        size: row.size,
        speechLikely: row.speechLikely === true,
      })),
      ...(shotPlan ? { shotPlan } : {}),
    };
  }

  async function prepareSingle(form) {
    const fileInput = form.querySelector('input[name="attachments"]');
    const files = [...(fileInput?.files ?? [])];
    const signature = files.map(file => `${file.name}:${file.size}:${file.lastModified}`).join("|");
    if (form.dataset.uploadSignature !== signature) {
      state.uploadedAttachments = [];
      const speechLikely = /口播|口述|访谈|出镜|讲话/.test(String(new FormData(form).get("intent") || ""));
      for (const file of files) state.uploadedAttachments.push(await uploadFile(file, { speechLikely }));
      form.dataset.uploadSignature = signature;
    }
    const input = formInput(form);
    const resolved = await api("/api/content-director/resolve-intent", { method: "POST", body: JSON.stringify(input) });
    state.preview = resolved;
    state.pendingInput = resolved.artifactKind ? input : null;
    render();
    if (!resolved.artifactKind) {
      state.notice = resolved.clarifyQuestion || "需要先补充内容类型。";
      render();
      return;
    }
    state.notice = resolved.missing?.length
      ? "路由已完成，但仍有必填项。确认后会保存为待补输入 Job。"
      : "路由和执行确认卡已生成。确认后才会建立并启动 Job。";
    render();
  }

  async function createConfirmed() {
    if (!state.pendingInput) throw new Error("请先完成路由识别。");
    const job = await api("/api/content-director/jobs", {
      method: "POST",
      headers: { "Idempotency-Key": key() },
      body: JSON.stringify(state.pendingInput),
    });
    state.selectedJob = job;
    if (!job.missing?.length) {
      state.selectedJob = await api(`/api/content-director/jobs/${encodeURIComponent(job.id)}/start`, {
        method: "POST",
        headers: { "Idempotency-Key": key(), "If-Match": job.etag },
        body: "{}",
      });
    }
    state.notice = job.missing?.length
      ? "任务已保存，但仍有必填项；补齐后才能启动。"
      : "任务已创建并进入生产线。页面不会把预生产或路由计划当作成片或发布。";
    state.preview = null;
    state.pendingInput = null;
    state.uploadedAttachments = [];
    await load();
  }

  async function createBatch(form) {
    const fields = new FormData(form);
    const topics = String(fields.get("topics") || "").split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (!topics.length) throw new Error("请至少填写一个主题。");
    const result = await api("/api/content-director/batches", {
      method: "POST",
      headers: { "Idempotency-Key": key() },
      body: JSON.stringify({
        name: fields.get("batchName"),
        topics: topics.map(intent => ({ intent })),
        shared: {
          platforms: String(fields.get("platforms") || "").split(/[,，]/).map(value => value.trim()).filter(Boolean),
          ...lengthInput(fields),
          allowWebResearch: fields.get("allowWebResearch") === "on",
          enableVisuals: true,
        },
      }),
    });
    state.notice = `已建立 ${result.jobs.length} 个独立 Job；批次不会共享上下文。`;
    await load();
  }

  async function bindIllustrations(form) {
    const job = state.selectedJob;
    if (job?.editorialIllustration?.status !== "waiting_for_images") throw new Error("当前任务没有待绑定的配图请求。");
    const receiptId = String(new FormData(form).get("receiptId") ?? "").trim();
    if (!/^AIR-[a-f0-9]{24}$/.test(receiptId)) throw new Error("请填写核验通过的配图回执 ID。");
    const previous = state.illustrationAttempt;
    const attempt = previous?.receiptId === receiptId && previous.jobId === job.id ? previous
      : { receiptId, jobId: job.id, etag: job.etag, idempotencyKey: key() };
    state.illustrationAttempt = attempt;
    try {
      await api(`/api/content-director/jobs/${encodeURIComponent(job.id)}/illustrations`, {
        method: "POST",
        headers: { "Idempotency-Key": attempt.idempotencyKey, "If-Match": attempt.etag },
        body: JSON.stringify({ receiptId }),
      });
      state.illustrationAttempt = null;
    } catch (error) {
      if (error.status >= 400 && error.status < 500) attempt.etag = job.etag;
      throw error;
    }
    state.notice = "已提交配图回执。达到图片要求并完成终审后，才可批准完整快照。";
    await load();
  }

  async function jobAction(action) {
    const job = state.selectedJob;
    if (!job) return;
    const visualGate = activeVisualGate(job);
    if (visualGate && ["resume", "repair", "approve", "final-review", "materialize", "content-ops"].includes(action)) {
      throw new Error(visualGate.message);
    }
    if (action === "publication") {
      state.publication = await api(`/api/content-director/jobs/${encodeURIComponent(job.id)}/publication-status`);
      render();
      return;
    }
    if (action === "approve" && root.querySelector("[data-cd-approved]")?.checked !== true) throw new Error("请先阅读完整正文、图表和审核问题。");
    const body = ["approve", "final-review"].includes(action)
      ? { reviewed: true, contentHash: job.result?.contentHash, note: "管理员在创作总控核对完整快照。" }
      : action === "repair"
        ? { reviewed: true }
      : action === "materialize"
        ? {
          contentHash: job.result?.contentHash,
          ...(job.result?.visuals?.length ? {
            visualRightsConfirmed: root.querySelector("[data-cd-visual-rights]")?.checked === true,
            visualRightsNote: root.querySelector("[data-cd-visual-note]")?.value || "",
          } : {}),
        }
        : action === "content-ops"
          ? {
            targets: [...root.querySelectorAll("[data-cd-ops-destination]:checked")]
              .map(input => ({ destinationId: input.value, locale: job.input.language, nativeForm: job.artifactKind === "pure_visual" ? "image_text" : job.artifactKind?.startsWith("video_") ? "video" : "article" })),
            goal: job.input.goal || job.result?.article?.title || job.input.intent,
            budgetAuthorizationId: null,
            sourceArtifactIds: [],
            nativeInputs: [],
          }
        : {};
    if (action === "materialize" && job.result?.visuals?.length && body.visualRightsConfirmed !== true) {
      throw new Error("请先核对并确认全部图表的权利与隐私。");
    }
    if (action === "content-ops" && !body.targets.length) throw new Error("请至少选择一个真实目的地。");
    const endpointAction = action === "content-ops" ? "create-content-ops-plan" : action === "final-review" ? "final-review" : action;
    await api(`/api/content-director/jobs/${encodeURIComponent(job.id)}/${endpointAction}`, {
      method: "POST",
      headers: { "Idempotency-Key": key(), "If-Match": job.etag },
      body: JSON.stringify(body),
    });
    state.selectedJob = await api(`/api/content-director/jobs/${encodeURIComponent(job.id)}`);
    state.notice = action === "materialize"
      ? "不可变 Edition 已建立。后续平台适配和发布仍需独立步骤。"
      : action === "approve"
        ? "当前完整内容快照已批准。"
        : action === "content-ops"
          ? "平台适配计划已建立；gap 不为 0 时仍不可生产或外发。"
          : action === "publication"
            ? "发布状态已按当前账本重新读取。"
        : "任务状态已更新。";
    await load();
  }

  async function moveVisual(visualId, direction) {
    const job = state.selectedJob;
    if (!job) return;
    const visualGate = activeVisualGate(job);
    if (visualGate) throw new Error(visualGate.message);
    const ids = (job.visualSpecs ?? []).map(row => row.id);
    const index = ids.indexOf(visualId), target = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await api(`/api/content-director/jobs/${encodeURIComponent(job.id)}/visuals`, {
      method: "PATCH",
      headers: { "Idempotency-Key": key(), "If-Match": job.etag },
      body: JSON.stringify({ orderedVisualIds: ids, updates: [] }),
    });
    state.notice = "视觉顺序已形成新 revision；原图和旧批准记录均保留。";
    await load();
  }

  async function controlBatch(batchId, action) {
    const batch = state.batches.find(row => row.id === batchId);
    if (!batch) return;
    await api(`/api/content-director/batches/${encodeURIComponent(batchId)}/${action}`, {
      method: "POST",
      headers: { "Idempotency-Key": key(), "If-Match": batch.etag },
      body: "{}",
    });
    state.notice = action === "pause" ? "批次已请求暂停；在途步骤完成后保留断点。" : action === "resume" ? "批次已恢复调度。" : "批次及其未完成 Job 已取消。";
    await load();
  }

  root.addEventListener("click", async event => {
    const button = event.target.closest("button");
    if (!button || state.busy) return;
    try {
      state.busy = true;
      if (button.hasAttribute("data-cd-refresh")) {
        await load();
      } else if (button.hasAttribute("data-cd-resolve")) {
        const form = button.closest("form");
        await prepareSingle(form);
      } else if (button.hasAttribute("data-cd-create-confirmed")) {
        button.disabled = true;
        await createConfirmed();
      } else if (button.hasAttribute("data-cd-clear-preview")) {
        state.preview = null;
        state.pendingInput = null;
        state.uploadedAttachments = [];
        render();
      } else if (button.dataset.cdJob) {
        state.selectedJob = await api(`/api/content-director/jobs/${encodeURIComponent(button.dataset.cdJob)}`);
        await load();
      } else if (button.dataset.cdVisualUp) {
        await moveVisual(button.dataset.cdVisualUp, "up");
      } else if (button.dataset.cdVisualDown) {
        await moveVisual(button.dataset.cdVisualDown, "down");
      } else if (button.dataset.cdBatch) {
        await controlBatch(button.dataset.cdBatchId, button.dataset.cdBatch);
      } else if (button.dataset.cdAction) {
        await jobAction(button.dataset.cdAction);
      }
    } catch (error) {
      state.error = error.message || "操作未完成。";
      if (showError) showError(error);
      render();
    } finally {
      state.busy = false;
    }
  });

  root.addEventListener("submit", async event => {
    event.preventDefault();
    if (state.busy) return;
    const form = event.currentTarget.querySelector(`form[data-cd-form="${event.target.dataset.cdForm}"]`);
    if (!form || !form.reportValidity()) return;
    const button = form.querySelector('button[type="submit"]');
    state.busy = true;
    state.error = null;
    button.disabled = true;
    try {
      if (event.target.dataset.cdForm === "batch") await createBatch(form);
      else if (event.target.dataset.cdForm === "illustrations") await bindIllustrations(form);
      else await prepareSingle(form);
    } catch (error) {
      state.error = error.message || "创建任务失败。";
      if (showError) showError(error);
      render();
    } finally {
      state.busy = false;
      button.disabled = false;
    }
  });

  render();
  return { load: async () => { await load(); }, render };
}
