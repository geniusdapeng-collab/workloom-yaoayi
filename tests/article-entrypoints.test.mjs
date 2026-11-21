import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
  const dispatched = [];
  app.contentDirector.model = {
    async generateOutline({ brief }) {
      dispatched.push(brief.topic);
      throw new Error("Expected terminal step in the local scheduler regression.");
    },
  };
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  const post = async (path, key, body, { method = "POST", etag } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", "Idempotency-Key": key, ...(etag ? { "If-Match": etag } : {}) },
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
    assert.equal(job.awaitingExplicitStart, true);
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

  const articlePath = `/api/content-director/jobs/${article.value.id}`;
  const edited = await post(`${articlePath}/brief`, "held-job-brief-edit-test", { goal: "写小院里两样手艺" },
    { method: "PATCH", etag: article.value.etag });
  assert.equal(edited.status, 200);
  checkDefault(edited.value);
  const froze = await post(`${articlePath}/outline`, "held-job-outline-test", {
    outline: {
      title: "杯子边上还有个座位",
      summary: "已确认材料中的小院手艺。",
      sections: ["壶嘴", "白瓷杯", "手上的活"].map((title, index) => ({
        key: `section-${index}`, title, purpose: "写手上的动作。", targetCharacters: 200, claimIds: ["C001"],
      })),
    },
  }, { etag: edited.value.etag });
  assert.equal(froze.status, 200);
  checkDefault(froze.value);

  const triggerIntent = "单独授权另一个文章任务";
  const trigger = await post("/api/content-director/jobs", "unrelated-create-test", {
    intent: triggerIntent, explicitKind: "article", claimIds: ["C001"],
  });
  assert.equal(trigger.status, 202);
  const started = await post(`/api/content-director/jobs/${trigger.value.id}/start`, "unrelated-start-test", {},
    { etag: trigger.value.etag });
  assert.equal(started.status, 202);
  const awaitFixtureFailure = async jobId => {
    const deadline = Date.now() + 5_000;
    let job = await app.contentDirector.getJob(jobId);
    while (Date.now() < deadline && job.status !== "failed") {
      await delay(15);
      job = await app.contentDirector.getJob(jobId);
    }
    assert.equal(job.status, "failed");
    return job;
  };
  await awaitFixtureFailure(trigger.value.id);
  assert.deepEqual(dispatched, [triggerIntent]);
  for (const row of [article.value, illustrated.value, ...geo.value.jobs]) {
    checkDefault(await app.contentDirector.getJob(row.id));
  }

  const geoJobId = geo.value.jobs[0].id;
  const resumed = await post(`/api/content-director/batches/${geo.value.id}/resume`, "geo-explicit-resume-test", {},
    { etag: geo.value.etag });
  assert.equal(resumed.status, 200);
  const finished = await awaitFixtureFailure(geoJobId);
  assert.equal(finished.awaitingExplicitStart, undefined);
  assert.deepEqual(dispatched, [triggerIntent, selected.title]);
});

test("direct use of the legacy model adapter cannot generate an article or photo article", async () => {
  const service = new LivePipelineService({});
  for (const contentType of ["article", "image_text"]) {
    await assert.rejects(service.generateContent({ contentType }), { code: "CONTENT_DIRECTOR_REQUIRED" });
  }
});
