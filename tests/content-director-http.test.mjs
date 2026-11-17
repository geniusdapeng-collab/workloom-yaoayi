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
});
