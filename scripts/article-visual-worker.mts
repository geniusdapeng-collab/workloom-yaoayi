import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  articleIllustrationReceiptDirectory, assertEditorialImageBytes, registerArticleIllustrationReceipt,
} from "../src/services/article-illustration-receipts.mjs";
import { createArticleVisualPreparationReviewer } from "../src/services/article-visual-preparation.mjs";
import { ARTICLE_MIN_ILLUSTRATIONS, isMeaningfulIllustrationText, normalizeOpenImageAttribution } from "../src/domain/article-illustration-policy.mjs";
import { hashObject } from "../src/domain/hash.mjs";
import { scanSensitiveText } from "../src/domain/policy.mjs";
import { SCOPE, inside } from "../src/video-runtime/config.mjs";

const [root, dataRoot, inputFile] = process.argv.slice(2);
const bin = promisify(execFile);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const digestPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[A-Za-z0-9_-]{1,120}$/;
const filenamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}\.(?:jpg|jpeg|png)$/i;
const scope = { tenantId: SCOPE.tenantId, workspaceId: SCOPE.workspaceId };
const width = 1536, height = 944;
const maxBytes = 20 * 1024 * 1024;
const toneColors = ["#D5CABC", "#BFCAC1", "#D0CFC8"];
const logResult = result => console.log("YAOAYI_ARTICLE_VISUAL_RESULT " + JSON.stringify(result));

function requirePrivate(info, file, max = maxBytes) {
  if ((process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0 ||
      (file ? !info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > max : !info.isDirectory())) {
    throw Error("ARTICLE_VISUAL_PRIVATE_FILE_INVALID");
  }
}
async function readPrivate(path, max) {
  if (await realpath(path) !== path) throw Error("ARTICLE_VISUAL_PRIVATE_FILE_INVALID");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    requirePrivate(info, true, max);
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw Error("ARTICLE_VISUAL_PRIVATE_FILE_CHANGED");
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
      throw Error("ARTICLE_VISUAL_PRIVATE_FILE_CHANGED");
    }
    return bytes;
  } finally { await handle.close(); }
}
function publicText(value, max) {
  return typeof value === "string" && isMeaningfulIllustrationText(value) && value.length <= max &&
    !/[<>\u0000-\u001f\u007f]/u.test(value) && !scanSensitiveText(value).length;
}
const readJSON = async (file, max = 256_000) => JSON.parse((await readPrivate(file, max)).toString("utf8"));
const writeJSON = (file, data, flag = "wx") => writeFile(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag });

async function prepare() {
  if (process.platform !== "darwin" || !root || !dataRoot || !inputFile ||
      !process.env.DATABASE_URL || !process.env.DATABASE_GATEWAY_URL ||
      !process.env.WORKLOOM_VISUAL_BRIDGE_TOKEN || process.env.WORKLOOM_VISUAL_BRIDGE_TENANT !== SCOPE.workspaceId) {
    throw Error("ARTICLE_VISUAL_PRIVATE_RUNTIME_REQUIRED");
  }
  requirePrivate(await lstat(dirname(inputFile)), false);
  const request = await readJSON(inputFile);
  const { job, images } = request;
  const { id: jobId, articleDraft, editorialIllustration: design } = job ?? {};
  if (request.schema !== "yaoayi.article-visual-preparation/v1" ||
      job?.status !== "needs_input" || !idPattern.test(jobId ?? "") || design?.status !== "waiting_for_images" ||
      !idPattern.test(design.requestId ?? "") || !digestPattern.test(design.draftHash ?? "") ||
      !Array.isArray(articleDraft?.article?.sections) || !Array.isArray(images) ||
      images.length < ARTICLE_MIN_ILLUSTRATIONS || images.length > 12 ||
      new Set(images.map(image => image.sha256)).size !== images.length ||
      new Set(images.map(image => image.file)).size !== images.length) throw Error("ARTICLE_VISUAL_BINDING_INVALID");
  const binding = { jobId, requestId: design.requestId, draftHash: design.draftHash, article: articleDraft.article };
  const engine = join(root, "engines/video-edit");
  const loader = relative => import(pathToFileURL(join(engine, relative)).href);
  const { Pool } = createRequire(join(engine, "package.json"))("pg");
  const sharp = createRequire(join(root, "package.json"))("sharp");
  const { runQuest } = await loader("packages/runtime/src/index.ts");
  const { routedLlmCall } = await loader("apps/server/src/service/llm.ts");
  const { createToolExecutorForScope } = await loader("bundles/geo-growth/connectors/visual-bridge/server-adapter.mts");
  const app = new Pool({ connectionString: process.env.DATABASE_URL });
  const gateway = new Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const runId = hashObject({ policy: "visual-preparation/v1", jobId, requestId: design.requestId, draftHash: design.draftHash, images }).slice(0, 24);
  const toolRoot = resolve(process.env.WORKLOOM_VISUAL_BRIDGE_OUT_DIR ?? "");
  if (toolRoot === dataRoot || !inside(dataRoot, toolRoot)) throw Error("ARTICLE_VISUAL_SCOPE_MISMATCH");
  const sourceDirectory = join(dirname(toolRoot), "assets", runId);
  const outputDirectory = join(toolRoot, runId);
  const handoff = join(dataRoot, "work", "article-visuals", runId);
  await Promise.all([sourceDirectory, outputDirectory, handoff].map(directory => mkdir(directory, { recursive: true, mode: 0o700 })));
  for (const directory of [sourceDirectory, outputDirectory, handoff]) {
    if (await realpath(directory) !== directory) throw Error("ARTICLE_VISUAL_PRIVATE_FILE_INVALID");
    requirePrivate(await lstat(directory), false);
  }
  const status = join(handoff, "completed.json");
  try {
    const previous = await readJSON(status);
    if (previous.jobId !== jobId || previous.draftHash !== design.draftHash) throw Error("ARTICLE_VISUAL_BINDING_CHANGED");
    return previous;
  } catch (error) { if (error.code !== "ENOENT") throw error; }

  const toolExecutor = createToolExecutorForScope(scope);
  const call = routedLlmCall({ gateway, scope, scene: "quest-plan", industry: "geo-growth" });
  if (!toolExecutor || !call || new URL(process.env.WORKLOOM_VISUAL_BRIDGE_URL).origin !== process.env.WORKLOOM_VISUAL_BRIDGE_URL ||
      new URL(process.env.WORKLOOM_VISUAL_BRIDGE_URL).hostname !== "127.0.0.1") {
    throw Error("ARTICLE_VISUAL_NATIVE_ADAPTERS_REQUIRED");
  }
  const modelJSON = async (prompt, prefix) => {
    const evidencePath = join(handoff, prefix + ".json");
    try {
      const previous = await readJSON(evidencePath);
      if (previous.promptHash !== sha(prompt)) throw Error("ARTICLE_VISUAL_MODEL_INPUT_CHANGED");
      return previous;
    }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    // A dispatch without a settled model receipt remains fenced on retry.
    await writeJSON(join(handoff, prefix + ".dispatch.json"), { promptHash: sha(prompt), dispatchedAt: new Date().toISOString() });
    const { rows: [before] } = await app.query("SELECT coalesce(max(seq),0) AS seq FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2", [scope.tenantId, scope.workspaceId]);
    const raw = await call(prompt, AbortSignal.timeout(150_000));
    const { rows } = await app.query(`SELECT event_id, payload->'model_trace'->>'responseHash' AS response_hash
      FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND seq>$3 AND payload->'decision'->>'action'='model.call'
      AND payload->'decision'->'after'->>'scene'='quest-plan' AND nullif(payload->'model_trace'->>'responseId','') IS NOT NULL ORDER BY seq`,
    [scope.tenantId, scope.workspaceId, before.seq]);
    if (rows.length !== 1 || !digestPattern.test(rows[0].response_hash ?? "")) throw Error("ARTICLE_VISUAL_MODEL_RECEIPT_REQUIRED");
    const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
    const result = { value, eventId: rows[0].event_id, responseHash: rows[0].response_hash, promptHash: sha(prompt) };
    await writeJSON(evidencePath, result);
    return result;
  };
  const privateReview = createArticleVisualPreparationReviewer({ binding, sourceDirectory, outputDirectory,
    reviewModel: ({ prompt, facts }) => modelJSON(prompt, "review-" + facts.fingerprint),
    recordReview: async evidence => {
      const file = join(handoff, "proof-" + evidence.fingerprint + ".json");
      try { await writeJSON(file, evidence); }
      catch (error) { if (error.code !== "EEXIST" || (await readJSON(file)).evidenceHash !== evidence.evidenceHash) throw error; }
    },
  });

  const items = [];
  try {
    for (const [index, image] of images.entries()) {
      if (!filenamePattern.test(image.file ?? "") || !digestPattern.test(image.sha256 ?? "") ||
          !publicText(image.title, 180) || !publicText(image.alt, 360) || !publicText(image.caption, 500)) throw Error("ARTICLE_VISUAL_INPUT_INVALID");
      const section = binding.article.sections.find(row => row.key === image.sectionKey);
      if (typeof section?.title !== "string" || !section.title.trim() || section.title.length > 300 ||
          scanSensitiveText(section.title).length || scanSensitiveText(String(section.body)).length) throw Error("ARTICLE_VISUAL_SECTION_REQUIRED");
      const sourcePath = join(sourceDirectory, image.file);
      const original = join(dirname(inputFile), image.file);
      const raw = await readPrivate(original);
      if (sha(raw) !== image.sha256) throw Error("ARTICLE_VISUAL_SOURCE_BYTES_MISMATCH");
      try { await copyFile(original, sourcePath, constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      if (sha(await readPrivate(sourcePath)) !== image.sha256) throw Error("ARTICLE_VISUAL_SOURCE_BYTES_MISMATCH");
      const attribution = normalizeOpenImageAttribution(image.attribution);
      const metadata = await sharp(raw).metadata();
      const scale = Math.max(width / metadata.width, height / metadata.height);
      const photoWidth = Math.round(metadata.width * scale), photoHeight = Math.round(metadata.height * scale);
      if (![photoWidth, photoHeight].every(value => Number.isSafeInteger(value) && value > 0 && value <= 8192)) throw Error("ARTICLE_VISUAL_SOURCE_GEOMETRY_MISMATCH");
      const threadId = "thr-yaoayi-article-" + runId + "-" + (index + 1);
      const name = "yaoayi-photo-" + runId + "-" + (index + 1);
      const claim = { jobId, requestId: binding.requestId, draftHash: binding.draftHash, sectionKey: image.sectionKey,
        sourceSha256: image.sha256, caption: image.caption, attribution };
      const goal = [
        "你是姚阿姨系统的视觉设计师。用指定开放许可实拍做正文参考配图；不添加文字、人物或虚构布景。",
        "为本机 Compositor 选择裁剪重心和轻微色调。仅 JSON：{\"focus\":\"center|upper|lower|left|right\",\"tone\":\"指定色值\",\"opacity\":0.02到0.055,\"reason\":\"与章节相关的具体取舍\"}。",
        JSON.stringify({ title: image.title, sourceTitle: attribution.title, caption: image.caption, chapter: section.title,
          chapterText: String(section.body).slice(0, 4500), allowedTones: toneColors, sourceWidth: metadata.width, sourceHeight: metadata.height }),
      ].join("\n");
      await app.query(`INSERT INTO threads (id,tenant_id,workspace_id,title,mode,status,progress_done,progress_total,created_by,agent_id,created_at,updated_at)
        SELECT $1,$2,$3,$4,'quest','queued',0,2,m.id,a.id,now(),now() FROM agents a
        JOIN members m ON m.workspace_id=a.workspace_id AND m.id=$6 AND m.role='owner'
        WHERE a.workspace_id=$3 AND a.preset_key=$5 AND a.status='ready' ON CONFLICT (id) DO NOTHING`,
      [threadId, scope.tenantId, scope.workspaceId, "姚阿姨文章照片 · " + image.title, "visual-designer", SCOPE.memberId]);
      const useDesigner = async prompt => {
        const custom = prompt.replace("只输出 JSON 数组，每步形如", "以任务末尾的裁剪 JSON 对象为最终合同。本机工位会把它转换为步骤：");
        const { value: art } = await modelJSON(custom + "\n按任务要求只输出单张图的裁剪 JSON 对象。", "plan-" + (index + 1));
        if (!["center","upper","lower","left","right"].includes(art?.focus) || !toneColors.includes(art.tone) ||
          !Number.isFinite(art.opacity) || art.opacity < 0.02 || art.opacity > 0.055 || !publicText(art.reason, 500)) {
          throw Error("ARTICLE_VISUAL_DESIGN_INVALID");
        }
        const xRatio = art.focus === "left" ? 0.18 : art.focus === "right" ? 0.82 : 0.5;
        const yRatio = art.focus === "upper" ? 0.18 : art.focus === "lower" ? 0.82 : 0.5;
        const recipe = { recipe_version: 1, name, canvas: { width, height, resolution: 72 }, layers: [
          { type: "image", name: image.title, source: sourcePath, x: Math.round((width-photoWidth)*xRatio),
            y: Math.round((height-photoHeight)*yRatio), width: photoWidth, height: photoHeight, opacity: 1 },
          { type: "solid", name: "轻量色调调整", color: art.tone, x: 0, y: 0, width, height, opacity: art.opacity },
        ], exports: [{ format: "png", path: name + ".png" }] };
        return JSON.stringify([
          { action: "visualwrite.compose", tool: "visualwrite.compose", objectType: "visual_asset", label: image.title,
            params: { has_portrait: false, has_third_party_asset: true, source_evidence: claim, recipe, out_dir: outputDirectory } },
          { action: "visualread.verify", tool: "visualread.verify", objectType: "visual_asset", label: "回读实际配图摘要",
            params: { path: join(outputDirectory, name + ".png"), width, height } },
        ]);
      };
      const result = await runQuest(app, gateway, scope, { threadId, goal, presetKey: "visual-designer", toolExecutor,
        reviewVisualPreparation: privateReview, llmCall: useDesigner, fallbackPlanner: () => { throw Error("ARTICLE_VISUAL_DESIGN_INVALID"); },
      });
      if (result.status !== "completed" || result.stepsDone !== 2) {
        return { status: "needs_input", jobId, draftHash: binding.draftHash, threadId, stage: result.status, reason: result.error ?? "ARTICLE_VISUAL_NATIVE_CHECK_REQUIRED" };
      }
      const output = join(outputDirectory, name + ".png");
      const bytes = await readPrivate(output);
      await assertEditorialImageBytes(bytes, { mime: "image/png" });
      const outputSha256 = sha(bytes);
      const { rows: events } = await app.query(`SELECT event_id,payload->'decision' AS decision,payload->'receipt' AS receipt FROM biz_events
        WHERE tenant_id=$1 AND workspace_id=$2 AND session_id=$3 ORDER BY seq`, [scope.tenantId, scope.workspaceId, threadId]);
      const accepted = events.find(row => row.decision.kind === "preparation_review" && row.decision.after?.accepted === true);
      const compose = events.find(row => row.receipt?.synced === true && row.receipt.mode === "real" && row.decision.action === "visualwrite.compose"
        && row.decision.preparation_review_ref === accepted?.event_id && row.decision.after?.result?.outputs?.some(file => file.sha256 === outputSha256));
      const verify = events.find(row => row.receipt?.synced === true && row.receipt.mode === "real" && row.decision.action === "visualread.verify"
        && row.decision.after?.result?.sha256 === outputSha256);
      if (!accepted || !compose || !verify) throw Error("ARTICLE_VISUAL_REAL_RECEIPTS_MISSING");
      const project = join(outputDirectory, name + ".comp");
      const archive = join(handoff, name + ".comp.zip");
      if (await realpath(project) !== project) throw Error("ARTICLE_VISUAL_PROJECT_UNSAFE");
      try { requirePrivate(await lstat(archive), true, 100 * 1024 * 1024); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        await bin("/usr/bin/ditto", ["-c", "-k", "--keepParent", project, archive], {
          env: { PATH: "/usr/bin:/bin" }, timeout: 60_000, maxBuffer: 64 * 1024,
        });
        await chmod(archive, 0o600);
      }
      const file = name + ".png";
      await writeFile(join(handoff, file), bytes, { mode: 0o600 });
      items.push({
        file, sha256: outputSha256, title: image.title, alt: image.alt, caption: image.caption, sectionKey: image.sectionKey,
        source: { type: "licensed", ref: attribution.landingUrl, attribution },
        workshop: { threadId, composeEventId: compose.event_id, verifyEventId: verify.event_id,
          modelEventId: accepted.decision.after.modelEventId, sourceSha256: image.sha256, outputSha256,
          recipeSha256: hashObject(compose.decision.params.recipe), projectSha256: sha(await readFile(archive)), changes: ["crop","tone"] },
        rights: { approved: true, note: "自动核对开放许可、作者署名和实际原图摘要，并将许可和处理说明保留在配图回执。" },
        privacy: { approved: true, note: "本机 Apple Vision 已检查实际来源字节，未检测到人脸。" },
        relevance: { approved: true, note: "独立原生模型初审已核对该来源、章节、图注和纪实参考标识。" },
      });
    }
    const manifest = join(handoff, "manifest.json");
    const bundle = { schema: "yaoayi.article-illustration-receipt/v1", jobId, requestId: binding.requestId,
      draftHash: binding.draftHash, reviewedBy: "姚阿姨系统独立配图初审", reviewedAt: new Date().toISOString(),
      renderer: "姚阿姨 visual-designer / 本机 Compositor", images: items };
    try { await writeJSON(manifest, bundle); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = await readJSON(manifest);
      if (hashObject({ ...bundle, reviewedAt: previous.reviewedAt }) !== hashObject(previous)) throw Error("ARTICLE_VISUAL_BINDING_CHANGED");
    }
    const receipt = await registerArticleIllustrationReceipt({
      directory: articleIllustrationReceiptDirectory({ rootDir: root }), inputFile: manifest,
    });
    const outcome = { status: "prepared", ...receipt, draftHash: binding.draftHash, directory: handoff };
    await writeJSON(status, outcome);
    return outcome;
  } finally { await Promise.all([app.end(), gateway.end()]); }
}
try { logResult(await prepare()); }
catch (error) {
  console.error(JSON.stringify({ code: /^[A-Z][A-Z_0-9]{2,96}$/.test(error.code ?? error.message) ? (error.code ?? error.message) : "ARTICLE_VISUAL_PREPARATION_FAILED" }));
  process.exitCode = 1;
}
