import { ApiError } from "../domain/errors.mjs";

const ID = "([A-Za-z0-9_-]{1,120})";
const ARTIFACT = "([A-Za-z0-9][A-Za-z0-9._-]{0,159})";

function adminContext(request, principal) {
  if (!["local", "session"].includes(principal?.method)) {
    throw new ApiError(403, "AGENT_SCOPE_DENIED", "内容总控仅允许管理员操作。");
  }
  return {
    actor: principal.actor,
    method: principal.method,
    idempotencyKey: request.headers["idempotency-key"],
    ifMatch: request.headers["if-match"],
  };
}

export async function routeContentDirector({
  request,
  response,
  url,
  principal,
  contentDirector,
  readJsonBody,
  writeJson,
  methodNotAllowed,
}) {
  const path = url.pathname;
  if (!path.startsWith("/api/content-director/")) return false;
  if (path === "/api/content-director/status") {
    if (request.method !== "GET") { methodNotAllowed(response, ["GET"]); return true; }
    if ([...url.searchParams].length) throw new ApiError(400, "CONTENT_DIRECTOR_QUERY_INVALID", "内容总控状态接口不接受查询参数。");
    writeJson(response, 200, contentDirector?.getStatus?.() ?? {
      schema: "pengmanager.content-director-status/v1",
      enabled: false,
      mode: "disabled",
      writable: false,
      autoStart: false,
      runningJobs: 0,
      maxConcurrentJobs: 0,
    });
    return true;
  }
  if (!contentDirector) throw new ApiError(503, "CONTENT_DIRECTOR_UNAVAILABLE", "内容总控服务尚未配置。");
  if ([...url.searchParams].length) throw new ApiError(400, "CONTENT_DIRECTOR_QUERY_INVALID", "内容总控接口不接受查询参数。");
  const ctx = adminContext(request, principal);

  if (path === "/api/content-director/metrics") {
    if (request.method !== "GET") { methodNotAllowed(response, ["GET"]); return true; }
    writeJson(response, 200, contentDirector.getMetrics());
    return true;
  }

  if (path === "/api/content-director/attachments") {
    if (request.method === "GET") {
      writeJson(response, 200, contentDirector.listAttachments());
      return true;
    }
    if (request.method === "POST") {
      let name = request.headers["x-artifact-name"];
      if (name !== undefined) {
        try { name = decodeURIComponent(name); }
        catch { throw new ApiError(400, "CONTENT_ATTACHMENT_NAME_INVALID", "附件名称编码无效。"); }
      }
      const size = Number(request.headers["x-content-size"]);
      const result = await contentDirector.uploadAttachment(request, {
        role: request.headers["x-artifact-role"],
        mime: request.headers["content-type"],
        size,
        sha256: request.headers["x-content-sha256"],
        name,
        speechLikely: request.headers["x-speech-likely"] === "true",
        durationSec: request.headers["x-content-duration"] === undefined ? null : Number(request.headers["x-content-duration"]),
      }, ctx);
      writeJson(response, 201, result, result?.etag ? { ETag: result.etag } : {});
      return true;
    }
    methodNotAllowed(response, ["GET", "POST"]);
    return true;
  }
  const attachmentBytes = path.match(new RegExp(`^/api/content-director/attachments/${ID}/bytes$`));
  if (attachmentBytes) {
    if (!["GET", "HEAD"].includes(request.method)) {
      methodNotAllowed(response, ["GET", "HEAD"]);
      return true;
    }
    const row = await contentDirector.readAttachment(attachmentBytes[1]);
    response.writeHead(200, {
      "Content-Type": row.mime,
      "Content-Length": row.bytes.length,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `inline; filename="${row.name.replaceAll('"', "")}"`,
    });
    response.end(request.method === "HEAD" ? undefined : row.bytes);
    return true;
  }

  if (path === "/api/content-director/resolve-intent") {
    if (request.method !== "POST") { methodNotAllowed(response, ["POST"]); return true; }
    writeJson(response, 200, await contentDirector.resolveIntent(await readJsonBody(request)));
    return true;
  }
  if (path === "/api/content-director/jobs") {
    if (request.method === "GET") {
      writeJson(response, 200, contentDirector.listJobs());
      return true;
    }
    if (request.method === "POST") {
      const result = await contentDirector.createJob(await readJsonBody(request), ctx);
      writeJson(response, 202, result);
      return true;
    }
    methodNotAllowed(response, ["GET", "POST"]);
    return true;
  }
  if (path === "/api/content-director/batches") {
    if (request.method === "GET") {
      writeJson(response, 200, contentDirector.listBatches());
      return true;
    }
    if (request.method === "POST") {
      const result = await contentDirector.createBatch(await readJsonBody(request), ctx);
      writeJson(response, 202, result);
      return true;
    }
    methodNotAllowed(response, ["GET", "POST"]);
    return true;
  }
  const batch = path.match(new RegExp(`^/api/content-director/batches/${ID}$`));
  if (batch) {
    if (request.method !== "GET") { methodNotAllowed(response, ["GET"]); return true; }
    const payload = contentDirector.getBatch(batch[1]);
    writeJson(response, 200, payload, payload.etag ? { ETag: payload.etag } : {});
    return true;
  }
  const batchAction = path.match(new RegExp(`^/api/content-director/batches/${ID}/(pause|resume|cancel)$`));
  if (batchAction) {
    if (request.method !== "POST") { methodNotAllowed(response, ["POST"]); return true; }
    await readJsonBody(request);
    const payload = await contentDirector.controlBatch(batch[1], { action: batchAction[2] }, ctx);
    writeJson(response, 200, payload, payload.etag ? { ETag: payload.etag } : {});
    return true;
  }

  const job = path.match(new RegExp(`^/api/content-director/jobs/${ID}$`));
  if (job) {
    if (request.method !== "GET") { methodNotAllowed(response, ["GET"]); return true; }
    const payload = await contentDirector.getJob(job[1]);
    writeJson(response, 200, payload, payload.etag ? { ETag: payload.etag } : {});
    return true;
  }
  if (path.match(new RegExp(`^/api/content-director/jobs/${ID}/steps$`))) {
    const matched = path.match(new RegExp(`^/api/content-director/jobs/${ID}/steps$`));
    if (request.method !== "GET") { methodNotAllowed(response, ["GET"]); return true; }
    writeJson(response, 200, contentDirector.getSteps(matched[1]));
    return true;
  }
  if (path.match(new RegExp(`^/api/content-director/jobs/${ID}/findings$`))) {
    const matched = path.match(new RegExp(`^/api/content-director/jobs/${ID}/findings$`));
    if (request.method !== "GET") { methodNotAllowed(response, ["GET"]); return true; }
    writeJson(response, 200, await contentDirector.getFindings(matched[1]));
    return true;
  }
  if (path.match(new RegExp(`^/api/content-director/jobs/${ID}/context$`))) {
    const matched = path.match(new RegExp(`^/api/content-director/jobs/${ID}/context$`));
    if (request.method !== "GET") { methodNotAllowed(response, ["GET"]); return true; }
    writeJson(response, 200, await contentDirector.getJobContext(matched[1]));
    return true;
  }
  if (path.match(new RegExp(`^/api/content-director/jobs/${ID}/brief$`))) {
    const matched = path.match(new RegExp(`^/api/content-director/jobs/${ID}/brief$`));
    if (request.method !== "PATCH") { methodNotAllowed(response, ["PATCH"]); return true; }
    const payload = await contentDirector.patchBrief(matched[1], await readJsonBody(request), ctx);
    writeJson(response, 200, payload, payload.etag ? { ETag: payload.etag } : {});
    return true;
  }
  if (path.match(new RegExp(`^/api/content-director/jobs/${ID}/outline/freeze$`)) ||
      path.match(new RegExp(`^/api/content-director/jobs/${ID}/outline$`))) {
    const matched = path.match(new RegExp(`^/api/content-director/jobs/${ID}/outline(?:/freeze)?$`));
    if (!["PATCH", "POST"].includes(request.method)) { methodNotAllowed(response, ["PATCH", "POST"]); return true; }
    const payload = await contentDirector.freezeOutline(matched[1], await readJsonBody(request), ctx);
    writeJson(response, 200, payload, payload.etag ? { ETag: payload.etag } : {});
    return true;
  }
  if (path.match(new RegExp(`^/api/content-director/jobs/${ID}/visuals$`))) {
    const matched = path.match(new RegExp(`^/api/content-director/jobs/${ID}/visuals$`));
    if (request.method !== "PATCH") { methodNotAllowed(response, ["PATCH"]); return true; }
    const payload = await contentDirector.reviseVisuals(matched[1], await readJsonBody(request), ctx);
    writeJson(response, 200, payload, payload.etag ? { ETag: payload.etag } : {});
    return true;
  }
  if (path.match(new RegExp(`^/api/content-director/jobs/${ID}/create-content-ops-plan$`))) {
    const matched = path.match(new RegExp(`^/api/content-director/jobs/${ID}/create-content-ops-plan$`));
    if (request.method !== "POST") { methodNotAllowed(response, ["POST"]); return true; }
    const payload = await contentDirector.createContentOpsPlan(matched[1], await readJsonBody(request), ctx);
    writeJson(response, 201, payload, payload.etag ? { ETag: payload.etag } : {});
    return true;
  }
  if (path.match(new RegExp(`^/api/content-director/jobs/${ID}/publication-status$`))) {
    const matched = path.match(new RegExp(`^/api/content-director/jobs/${ID}/publication-status$`));
    if (request.method !== "GET") { methodNotAllowed(response, ["GET"]); return true; }
    writeJson(response, 200, contentDirector.getPublicationStatus(matched[1]));
    return true;
  }
  const action = path.match(new RegExp(`^/api/content-director/jobs/${ID}/(start|pause|resume|cancel|approve|final-review|repair|materialize|materialize-edition)$`));
  if (action) {
    if (request.method !== "POST") { methodNotAllowed(response, ["POST"]); return true; }
    const body = await readJsonBody(request);
    if (action[2] === "start") {
      const payload = await contentDirector.startJob(action[1], ctx);
      writeJson(response, 202, payload, payload.etag ? { ETag: payload.etag } : {});
    } else if (action[2] === "pause") {
      const payload = await contentDirector.pauseJob(action[1], ctx);
      writeJson(response, 200, payload, payload.etag ? { ETag: payload.etag } : {});
    } else if (action[2] === "resume") {
      const payload = await contentDirector.resumeJob(action[1], ctx);
      writeJson(response, 202, payload, payload.etag ? { ETag: payload.etag } : {});
    } else if (action[2] === "cancel") {
      const payload = await contentDirector.cancelJob(action[1], ctx);
      writeJson(response, 200, payload, payload.etag ? { ETag: payload.etag } : {});
    } else if (["approve", "final-review"].includes(action[2])) {
      const payload = await contentDirector.approveJob(action[1], body, ctx);
      writeJson(response, 200, payload, payload.etag ? { ETag: payload.etag } : {});
    } else if (action[2] === "repair") {
      if (body?.reviewed !== true) throw new ApiError(422, "CONTENT_REPAIR_REVIEW_REQUIRED", "请先阅读现有 finding 和阻塞原因再发起修复。");
      const payload = await contentDirector.startJob(action[1], ctx);
      writeJson(response, 202, payload, payload.etag ? { ETag: payload.etag } : {});
    } else {
      writeJson(response, 201, await contentDirector.materializeEdition(action[1], body, ctx));
    }
    return true;
  }
  const artifact = path.match(new RegExp(`^/api/content-director/jobs/${ID}/artifacts/${ARTIFACT}$`));
  if (artifact) {
    if (!["GET", "HEAD"].includes(request.method)) {
      methodNotAllowed(response, ["GET", "HEAD"]);
      return true;
    }
    const row = await contentDirector.readArtifact(artifact[1], artifact[2]);
    response.writeHead(200, {
      "Content-Type": row.mime,
      "Content-Length": row.bytes.length,
      "Cache-Control": "no-store",
      "Content-Disposition": `inline; filename="${row.name}"`,
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") response.end();
    else response.end(row.bytes);
    return true;
  }
  throw new ApiError(404, "CONTENT_DIRECTOR_ENDPOINT_NOT_FOUND", "内容总控接口不存在。");
}
