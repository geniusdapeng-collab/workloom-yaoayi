import { hashObject } from "../domain/hash.mjs";
import { ApiError } from "../domain/errors.mjs";
import { standardVideoIntent } from "./standard-workflow.mjs";

const REAL_SOURCES = new Set(["real_footage", "talking_head", "stock_or_authorized", "graphic_card"]);

function fail(code, message, details) {
  throw new ApiError(409, code, message, details);
}

function attachmentRows(job) {
  return (job.input?.attachments ?? []).filter(row => row.kind === "video" || row.kind === "image" || row.kind === "transcript");
}

function standardAiHandoff(job) {
  const plan = standardVideoIntent({ intent: job.input.intent, durationSec: job.input.durationSec });
  const jobId = hashObject(plan.input);
  return {
    executorId: "pengmanager.standard-video",
    pipeline: `video.${plan.input.route}.v1`,
    command: {
      executable: "node",
      script: "scripts/video-standard.mjs",
      planArgs: ["plan", "--input-file", "-"],
      startArgs: ["start", "--input-file", "-"],
      statusArgs: ["status", "--job", jobId],
    },
    plan,
    jobId,
    tools: ["native Studio", "current preproduction archive", "qualified shot render", "official post", "media verification"],
  };
}

function editHandoff(job) {
  const media = attachmentRows(job);
  if (!media.some(row => row.kind === "video")) fail("VIDEO_SOURCE_MISSING", "实拍剪辑需要真实视频附件。");
  if (job.input.videoRightsConfirmed !== true) fail("VIDEO_RIGHTS_REVIEW_REQUIRED", "先核对真实素材的版权、隐私与使用授权。");
  return {
    executorId: job.artifactKind === "video_talking_head" ? "workloom.edit.talk" : "workloom.edit.auto",
    pipeline: job.artifactKind === "video_talking_head" ? "video.talking_head.v1" : "video.edit.v1",
    entrypoint: job.artifactKind === "video_talking_head"
      ? "engines/video-edit/scripts/tools/edit-talk-cut.mts"
      : "engines/video-edit/scripts/tools/edit-auto.mts",
    tools: job.artifactKind === "video_talking_head"
      ? ["ASR", "word timeline", "talk cut", "subtitle", "official post", "decode verification"]
      : ["media probe", "auto edit", "timeline validation", "subtitle", "official post", "decode verification"],
    sourceReceipts: media.map(row => ({ id: row.id, mime: row.mime, sha256: row.sha256, bytes: row.size ?? row.bytes, speechLikely: row.speechLikely === true })),
  };
}

function mixedHandoff(job) {
  const shots = job.route?.shotPlan;
  if (!Array.isArray(shots) || !shots.length) fail("VIDEO_MIX_PLAN_REQUIRED", "混合视频需要逐镜头来源清单。");
  if (job.input.videoRightsConfirmed !== true) fail("VIDEO_RIGHTS_REVIEW_REQUIRED", "先核对真实镜头、图片与图文卡的版权和隐私。");
  const attachments = new Map((job.input.attachments ?? []).map(row => [row.id, row]));
  const normalized = shots.map((shot, index) => {
    const attachment = shot.attachmentId ? attachments.get(shot.attachmentId) : null;
    if (REAL_SOURCES.has(shot.sourceType) && !attachment) fail("VIDEO_SHOT_SOURCE_MISSING", `第 ${index + 1} 个镜头引用的真实附件不存在。`);
    return {
      shotId: `SHOT-${String(index + 1).padStart(3, "0")}`,
      sourceType: shot.sourceType,
      durationSec: shot.durationSec,
      source: attachment ? {
        attachmentId: attachment.id,
        mime: attachment.mime,
        sha256: attachment.sha256,
        bytes: attachment.size ?? attachment.bytes,
        authorizationId: shot.authorizationId,
      } : null,
      description: shot.description,
    };
  });
  const totalDurationSec = normalized.reduce((total, shot) => total + shot.durationSec, 0);
  if (totalDurationSec !== job.input.durationSec) fail("VIDEO_MIX_DURATION_MISMATCH", "混合镜表时长与目标成片时长不一致。");
  return {
    executorId: "workloom.video.mixed",
    pipeline: "video.mixed.v1",
    entrypoint: "engines/video-edit/apps/server/src/video/production-router.ts",
    tools: ["shot source manifest", "AI qualification", "real source preservation", "unified timeline", "official post", "per-shot provenance readback"],
    shots: normalized,
    totalDurationSec,
    manifestHash: hashObject(normalized),
  };
}

export function createContentVideoHandoff(job, { capabilities = null } = {}) {
  if (!job?.artifactKind?.startsWith("video_")) fail("CONTENT_VIDEO_ROUTE_REQUIRED", "当前 Job 不是视频生产线。");
  let route;
  if (job.artifactKind === "video_ai") route = standardAiHandoff(job);
  else if (job.artifactKind === "video_mixed") route = mixedHandoff(job);
  else route = editHandoff(job);
  const capabilityState = capabilities && typeof capabilities === "object"
    ? {
      ready: capabilities.ready === true,
      state: capabilities.state ?? "unverified",
      sourceMain: capabilities.sourceMain ?? null,
      modelReadiness: capabilities.modelReadiness ?? null,
      relevantMissing: (capabilities.categories ?? []).flatMap(category => category.missing ?? []).slice(0, 50),
    }
    : { ready: false, state: "unverified", sourceMain: null, modelReadiness: null, relevantMissing: ["video-runtime-capabilities-unverified"] };
  return {
    schema: "pengmanager.content-video-handoff/v1",
    jobId: job.id,
    artifactKind: job.artifactKind,
    durationSec: job.input.durationSec,
    route,
    sourceReceipts: attachmentRows(job).map(row => ({
      id: row.id,
      kind: row.kind,
      mime: row.mime,
      sha256: row.sha256,
      bytes: row.size ?? row.bytes,
    })),
    capabilityState,
    budgetAuthorized: false,
    productionAuthorized: false,
    productionVerified: false,
    publicationAuthorized: false,
    gates: [
      "native-video-runtime-ready",
      "single-use-budget-authorization",
      "source-rights-review",
      "native-preproduction",
      "qualified-render",
      "official-post-and-decode-verification",
    ],
    handoffHash: hashObject({ route, capabilityState }),
  };
}
