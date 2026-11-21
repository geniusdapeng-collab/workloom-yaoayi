import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
import { createGeoOsServer } from "../src/http/server.mjs";

async function jsonRequest(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  return { response, payload: await response.json() };
}

test("content director HTTP routes preserve admin scope, idempotency and job visibility", async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "pm-director-http-"));
  const store = new JsonStore({ filePath: join(directory, "state.json") });
  await store.open(() => loadSeedState(resolve(import.meta.dirname, "../data/seed")));
  await migrateEditorialState(store, { publicOrigin: "https://pengmanager.com" });
  const backup = createEditorialBackup({ store });
  await migrateContentOpsState(store, { beforeMigration: () => backup.captureCurrent() });
  await migrateContentDirectorState(store, { beforeMigration: () => backup.captureCurrent() });
  const service = new GeoOsService({ store });
  await service.approveClaim("C003", { approvedBy: "isolated HTTP reviewer", publicLevel: "private" });
  const editorial = new EditorialService({ store, geoService: service, publicOrigin: "https://pengmanager.com" });
  const contentDirector = new ContentDirectorService({ store, model: null, editorial, artifactRoot: join(directory, "content-director"), autoStart: false });
  const server = createGeoOsServer({ service, editorial, contentDirector, publicDir: resolve(import.meta.dirname, "../public") });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    await new Promise(done => server.close(done));
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const resolved = await jsonRequest(baseUrl, "/api/content-director/resolve-intent", {
    method: "POST",
    body: JSON.stringify({ intent: "围绕 Agent 产品如何进入真实业务写一篇文章", targetLength: { minCharacters: 2000, maxCharacters: 3000 } }),
  });
  assert.equal(resolved.response.status, 200);
  assert.equal(resolved.payload.artifactKind, "article");
  assert.equal(resolved.payload.articleIllustrations.minimum, 3);
  const key = randomUUID();
  const input = {
    intent: "围绕 Agent 产品如何进入真实业务写一篇文章",
    claimIds: ["C003"],
    targetLength: { minCharacters: 2000, maxCharacters: 3000 },
  };
  const created = await jsonRequest(baseUrl, "/api/content-director/jobs", {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify(input),
  });
  assert.equal(created.response.status, 202);
  assert.equal(created.payload.artifactKind, "article");
  assert.ok(created.payload.id.startsWith("CDJ-"));
  const replay = await jsonRequest(baseUrl, "/api/content-director/jobs", {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify(input),
  });
  assert.equal(replay.payload.id, created.payload.id);
  const jobs = await jsonRequest(baseUrl, "/api/content-director/jobs");
  assert.equal(jobs.response.status, 200);
  assert.ok(jobs.payload.items.some(job => job.id === created.payload.id));
  const detail = await jsonRequest(baseUrl, `/api/content-director/jobs/${created.payload.id}`);
  assert.equal(detail.payload.steps[0].kind, "route.resolve");
  assert.equal(detail.payload.publicationAuthorized, undefined);
  assert.equal(detail.payload.route.publicationAuthorized, false);
  const illustrationBinding = `/api/content-director/jobs/${created.payload.id}/illustrations`;
  const receiptId = `AIR-${"a".repeat(24)}`;
  for (const [body, status, code] of [
    [{ receiptId, images: [] }, 400, "ARTICLE_ILLUSTRATION_RECEIPT_INVALID"],
    [{ receiptId }, 409, "ARTICLE_ILLUSTRATION_BINDING_NOT_READY"],
  ]) {
    const rejected = await jsonRequest(baseUrl, illustrationBinding, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID(), "If-Match": detail.payload.etag },
      body: JSON.stringify(body),
    });
    assert.equal(rejected.response.status, status);
    assert.equal(rejected.payload.error.code, code);
  }

  const source = Buffer.from("# Verified author source\n\nExact bytes for the HTTP upload regression.\n");
  const uploadedResponse = await fetch(`${baseUrl}/api/content-director/attachments`, {
    method: "POST",
    headers: {
      "Content-Type": "text/markdown",
      "X-Artifact-Role": "document",
      "X-Content-Size": String(source.length),
      "X-Content-Sha256": createHash("sha256").update(source).digest("hex"),
      "X-Artifact-Name": encodeURIComponent("author-source.md"),
      "Idempotency-Key": randomUUID(),
    },
    body: source,
  });
  const uploaded = await uploadedResponse.json();
  assert.equal(uploadedResponse.status, 201);
  assert.match(uploaded.id, /^CDU-/);
  const jobWithSource = await jsonRequest(baseUrl, "/api/content-director/jobs", {
    method: "POST",
    headers: { "Idempotency-Key": randomUUID() },
    body: JSON.stringify({
      intent: "根据真实作者来源写一篇技术文章",
      explicitKind: "article",
      attachments: [{ kind: "document", id: uploaded.id }],
      targetLength: { minCharacters: 2000, maxCharacters: 3000 },
    }),
  });
  assert.equal(jobWithSource.response.status, 202);
  assert.equal(jobWithSource.payload.input.attachments[0].sha256, uploaded.sha256);
  const metrics = await jsonRequest(baseUrl, "/api/content-director/metrics");
  assert.equal(metrics.response.status, 200);
  assert.equal(metrics.payload.jobs.total, 2);

  const short = { minCharacters: 500, maxCharacters: 800 };
  const courtyard = { intent: "写一篇小院日记，并配三张照片", claimIds: ["C003"] };
  const preview = await jsonRequest(baseUrl, "/api/content-director/resolve-intent", {
    method: "POST", body: JSON.stringify(courtyard),
  });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.payload.artifactKind, "article_visual");
  assert.deepEqual(preview.payload.targetLength, short);

  const createdShort = await jsonRequest(baseUrl, "/api/content-director/jobs", {
    method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: JSON.stringify(courtyard),
  });
  assert.equal(createdShort.response.status, 202);
  assert.equal(createdShort.payload.stylePolicy.version, "1.3.0");
  assert.deepEqual(createdShort.payload.route.targetLength, short);
  assert.deepEqual(createdShort.payload.input.targetLength, short);

  const updatedShort = await jsonRequest(baseUrl, `/api/content-director/jobs/${createdShort.payload.id}/brief`, {
    method: "PATCH", headers: { "Idempotency-Key": randomUUID(), "If-Match": createdShort.payload.etag },
    body: JSON.stringify({ targetLength: { maxCharacters: 725 } }),
  });
  assert.equal(updatedShort.response.status, 200);
  assert.deepEqual(updatedShort.payload.route.targetLength, { minCharacters: 500, maxCharacters: 725 });
  assert.deepEqual(updatedShort.payload.stylePolicy, createdShort.payload.stylePolicy);

  const updatedLong = await jsonRequest(baseUrl, `/api/content-director/jobs/${created.payload.id}/brief`, {
    method: "PATCH", headers: { "Idempotency-Key": randomUUID(), "If-Match": detail.payload.etag },
    body: JSON.stringify({ audience: "创业团队" }),
  });
  assert.equal(updatedLong.response.status, 200);
  assert.deepEqual(updatedLong.payload.route.targetLength, { minCharacters: 2000, maxCharacters: 3000 });

  const batch = await jsonRequest(baseUrl, "/api/content-director/batches", {
    method: "POST", headers: { "Idempotency-Key": randomUUID() },
    body: JSON.stringify({
      name: "短稿默认篇幅",
      shared: { claimIds: ["C003"] },
      topics: [
        { intent: "写一篇摊煎饼的手艺文章", explicitKind: "article" },
        { intent: "Write an illustrated explainer", explicitKind: "article_visual", language: "en-US" },
      ],
    }),
  });
  assert.equal(batch.response.status, 202);
  assert.deepEqual(batch.payload.jobs.map(job => job.route.targetLength), [short, short]);
  assert.deepEqual(batch.payload.jobs.map(job => job.stylePolicy.version), ["1.3.0", "1.3.0"]);
});
