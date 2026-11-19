import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { planWorkbenchIntent, workbenchManifest } from "../src/workbench-intent.mjs";
import { createGeoOsServer } from "../src/http/server.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("article intent reuses the existing route and exposes approval and delivery stages", () => {
  const needsFacts = planWorkbenchIntent({
    intent: "围绕姚阿姨的沂蒙山秋日山货写一篇图文，并配一张信息图",
  });
  assert.equal(needsFacts.status, "needs_input");
  assert.equal(needsFacts.route.artifactKind, "article_visual");
  assert.equal(needsFacts.route.pipeline, "article.v1");
  assert.ok(needsFacts.requiredInputs.includes("至少一条已批准 Claim ID"));
  assert.equal(needsFacts.planOnly, true);
  assert.equal(needsFacts.writesPerformed, false);
  assert.equal(needsFacts.providerCallsPerformed, false);
  assert.equal(needsFacts.productionVerified, false);

  const planned = planWorkbenchIntent({
    intent: "围绕姚阿姨的沂蒙山秋日山货写一篇图文，并配一张信息图",
    claimIds: ["C001"],
  });
  assert.equal(planned.status, "planned");
  assert.equal(planned.persona.id, "yao_ayi_yimeng_coffee_courtyard");
  assert.equal(planned.persona.version, "1.0.1");
  assert.deepEqual(planned.requiredInputs, []);
  assert.ok(planned.stages.some((stage) => stage.id === "persona-bind" && stage.status === "completed"));
  assert.ok(planned.stages.some((stage) => stage.id === "create-content-job" && stage.executor === "administrator-session"));
  assert.ok(planned.stages.some((stage) => stage.id === "visual-package"));
  const review = planned.stages.find((stage) => stage.id === "human-review");
  assert.deepEqual(review.dependsOn, ["produce", "visual-package"]);
  assert.ok(planned.stages.some((stage) => stage.id === "materialize"));
  assert.equal(planned.stages.some((stage) => stage.id === "publication"), false);
  assert.ok(planned.authorizationGates.some((gate) => gate.id === "no-self-approval"));
  assert.ok(planned.authorizationGates.some((gate) => gate.id === "persona-contract"));
  assert.equal(planned.delivery.status, "not_started");
  assert.match(planned.planHash, /^[a-f0-9]{64}$/);
});

test("video intent preserves the original sentence and enters the existing native workflow", () => {
  const raw = "用姚阿姨系统做一支三十秒的 AI 生成咖啡小院短片";
  const plan = planWorkbenchIntent({ intent: raw, durationSec: 30, publicationRequested: true });
  assert.equal(plan.status, "planned");
  assert.equal(plan.route.intent, raw);
  assert.equal(plan.route.artifactKind, "video_ai");
  assert.equal(plan.route.durationSec, 30);
  assert.equal(plan.persona.documentSha256, "a81ff53526b57d759ca5ae8465db8a6056a7fd82b68bb60625efa8ff55d46e7c");
  assert.ok(plan.stages.some((stage) => stage.id === "preflight" && stage.entry.tool === "pengmanager_video_preflight"));
  const start = plan.stages.find((stage) => stage.id === "start");
  assert.equal(start.entry.input.intent, raw);
  assert.equal(start.entry.input.durationSec, 30);
  assert.ok(plan.authorizationGates.some((gate) => gate.id === "paid-budget"));
  assert.ok(plan.authorizationGates.some((gate) => gate.id === "single-target-publication"));
  assert.equal(plan.stages.at(-1).id, "publication");
  assert.equal(plan.productionVerified, false);
});

test("ambiguous and unknown workbench fields fail without pretending to execute", () => {
  const ambiguous = planWorkbenchIntent({ intent: "帮我处理一下这件事" });
  assert.equal(ambiguous.status, "needs_input");
  assert.equal(ambiguous.route.artifactKind, null);
  assert.match(ambiguous.nextStep, /文章|图片|视频/);
  assert.throws(() => planWorkbenchIntent({ intent: "写一篇文章", command: "publish" }), {
    code: "WORKBENCH_INTENT_INVALID",
  });
  assert.throws(() => planWorkbenchIntent({ intent: "" }), {
    code: "WORKBENCH_INTENT_INVALID",
  });
});

test("publication and delivery plans respect explicit negated instructions", () => {
  const draftOnly = planWorkbenchIntent({
    intent: "写一篇姚阿姨山货文章，只做草稿，不要发布，也不需要导出成片",
    claimIds: ["C001"],
  });
  assert.equal(draftOnly.publicationRequested, false);
  assert.equal(draftOnly.deliveryRequested, false);
  assert.equal(draftOnly.stages.some((stage) => stage.id === "publication"), false);
  assert.equal(draftOnly.authorizationGates.some((gate) => gate.id === "single-target-publication"), false);

  const publish = planWorkbenchIntent({
    intent: "写一篇姚阿姨山货文章，审核后发到公众号",
    claimIds: ["C001"],
  });
  assert.equal(publish.publicationRequested, true);
  assert.equal(publish.stages.at(-1).id, "publication");
});

test("manifest declares verified clients and the unverified Qianwen fallback", () => {
  const manifest = workbenchManifest();
  assert.equal(manifest.productId, "yaoayi-system");
  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(manifest.clients.find((row) => row.id === "codex").status, "supported");
  assert.equal(manifest.clients.find((row) => row.id === "workbuddy").status, "connector-package-supported");
  assert.equal(manifest.clients.find((row) => row.id === "qoderwork").status, "mcp-json-supported");
  assert.equal(manifest.clients.find((row) => row.id === "qoderwork").discontinuationDate, "2027-09-05");
  assert.equal(manifest.clients.find((row) => row.id === "qianwen-office").status, "generic-fallback");
  assert.equal(manifest.persona.requireFirstPerson, true);
  assert.equal(manifest.guarantees.productionVerified, false);
});

test("public HTTP manifest and plan routes are read-only and reject unsupported methods or fields", async (t) => {
  const server = createGeoOsServer({ service: {}, publicDir: path.join(root, "public") });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const manifestResponse = await fetch(`${base}/api/workbench/manifest`);
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.schemaVersion, "yaoayi.workbench-manifest/v1");
  assert.equal(manifest.persona.version, "1.0.1");

  const planResponse = await fetch(`${base}/api/workbench/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: "做一张沂蒙山秋天的信息图" }),
  });
  assert.equal(planResponse.status, 200);
  const plan = await planResponse.json();
  assert.equal(plan.route.artifactKind, "pure_visual");
  assert.equal(plan.planOnly, true);
  assert.equal(plan.writesPerformed, false);

  const wrongMethod = await fetch(`${base}/api/workbench/plan`);
  assert.equal(wrongMethod.status, 405);
  const invalid = await fetch(`${base}/api/workbench/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: "写一篇文章", shell: "rm -rf" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "WORKBENCH_INTENT_INVALID");
});
