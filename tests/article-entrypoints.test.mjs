import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createYaoAyiApplication } from "../src/application.mjs";
import { LivePipelineService } from "../src/services/live-pipeline.mjs";

test("legacy article requests create governed jobs instead of writing raw drafts", async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "yaoayi-article-entrypoints-"));
  const app = await createYaoAyiApplication({
    rootDir: resolve(import.meta.dirname, ".."),
    env: {
      NODE_ENV: "development",
      DATA_FILE: join(directory, "state.json"),
      GEO_ENGINE_DB: join(directory, "geo.sqlite"),
      CONTENT_DIRECTOR_MODE: "enabled",
      ENABLE_MEDIA_RENDER: "false",
    },
    finalContentBackup: null,
  });
  t.after(async () => {
    try { await app.stop(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  await app.service.approveClaim("C001", { approvedBy: "HTTP fixture", publicLevel: "private" });
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  const post = async (path, key, body) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  };
  const checkDefault = job => {
    assert.equal(job.stylePolicy.version, "1.3.0");
    assert.deepEqual(job.input.targetLength, { minCharacters: 500, maxCharacters: 800 });
    assert.deepEqual(job.route.targetLength, job.input.targetLength);
    assert.equal(job.route.publicationAuthorized, false);
    assert.equal(job.status, "needs_resume");
  };
  const originalContentCount = app.store.snapshot().content.length;
  const originalGeoDraftCount = app.geoEngine.listArticles().length;
  const livePath = "/api/live/generate-content";
  const liveRequest = { confirm: true, brief: "写一篇姚阿姨小院随笔", claimIds: ["C001"] };
  const article = await post(livePath, "article-live-entry-test", { ...liveRequest, contentType: "article" });
  assert.equal(article.status, 202);
  assert.equal(article.value.artifactKind, "article");
  assert.equal(article.value.stylePolicy.genre, "courtyard");
  checkDefault(article.value);
  const replay = await post(livePath, "article-live-entry-test", { ...liveRequest, contentType: "article" });
  assert.equal(replay.value.id, article.value.id);
  const illustrated = await post(livePath, "illustrated-live-entry-test", {
    ...liveRequest, brief: "Explain what makes a trustworthy record of pantry goods.", contentType: "image_text", language: "en-US",
  });
  assert.equal(illustrated.status, 202);
  assert.equal(illustrated.value.artifactKind, "article_visual");
  assert.equal(illustrated.value.input.language, "en-US");
  assert.equal(illustrated.value.stylePolicy.genre, "explainer");
  checkDefault(illustrated.value);

  const geoPath = "/api/geo/engine/articles/generate";
  const [selected] = app.geoEngine.articleTopics();
  const geoRequest = { confirm: true, topicIds: [selected.id], claimIds: ["C001"] };
  const rejected = await post(geoPath, "invalid-geo-entry-test", { ...geoRequest, topicIds: ["unknown-topic"] });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.value.error.code, "GEO_ARTICLE_TOPIC_INVALID");
  const geo = await post(geoPath, "valid-geo-entry-test", geoRequest);
  assert.equal(geo.status, 202);
  assert.equal(geo.value.jobs.length, 1);
  assert.equal(geo.value.jobs[0].input.intent, selected.title);
  checkDefault(geo.value.jobs[0]);
  assert.equal(app.geoEngine.listArticles().length, originalGeoDraftCount);
  assert.equal(app.store.snapshot().content.length, originalContentCount);
  assert.equal(app.contentDirector.getStatus().runningJobs, 0);
});

test("direct use of the legacy model adapter cannot generate an article or photo article", async () => {
  const service = new LivePipelineService({});
  for (const contentType of ["article", "image_text"]) {
    await assert.rejects(service.generateContent({ contentType }), { code: "CONTENT_DIRECTOR_REQUIRED" });
  }
});
