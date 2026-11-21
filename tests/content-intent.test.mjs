import test from "node:test";
import assert from "node:assert/strict";
import { resolveContentIntent } from "../src/domain/content-intent.mjs";

test("article intent with an embedded question remains article work", () => {
  const route = resolveContentIntent({
    intent: "围绕 Agent 产品如何进入真实业务写一篇 3000 字技术文章",
    targetLength: { minCharacters: 2500, maxCharacters: 4000 },
  });
  assert.equal(route.artifactKind, "article");
  assert.equal(route.pipeline, "article.v1");
  assert.equal(route.needs.claims, true);
  assert.equal(route.needs.articleIllustrations, true);
  assert.equal(route.articleIllustrations.minimum, 3);
  assert.equal(route.articleIllustrations.executor, "visual-designer");
  assert.deepEqual(route.missing, []);
});

test("article plus a long architecture title still resolves to article_visual", () => {
  const route = resolveContentIntent({
    intent: "围绕 AI 自主经营系统写一篇文章，并配一张包含用户、平台、模型三层的产品架构图",
  });
  assert.equal(route.artifactKind, "article_visual");
  assert.equal(route.enableVisuals, true);
  assert.equal(route.visualForm.mode, "technical");
  assert.deepEqual(route.visualForm.kinds, ["architecture"]);
  assert.equal(route.articleIllustrations.minimum, 3);
});

test("illustrated articles stay with the designer when a technical form is absent, negated, or only discussed", () => {
  const illustrated = [
    { intent: "写一篇关于小院的文章，为正文配图" },
    { intent: "写一篇关于系统架构图的文章，另给正文配图" },
    { intent: "写一篇《如何做信息图》的文章，并配一张图" },
    { intent: "写一篇介绍「如何制作信息图」的文章，并配图" },
    { intent: "写一篇文章，不要流程图，给正文配图" },
    { intent: "写一篇文章，并配一张架构图，再为正文设计插画" },
    { intent: "写一篇文章，主视觉一张，附信息图" },
    { intent: "写一篇文章，要一张主视觉并附一张信息图" },
    { intent: "给我一篇图文，讲小院生活" },
    { intent: "写一篇小院日记", explicitKind: "article_visual", enableVisuals: true },
  ];
  for (const input of illustrated) {
    const route = resolveContentIntent(input);
    assert.equal(route.artifactKind, "article_visual", input.intent);
    assert.equal(route.visualForm.mode, "editorial", input.intent);
    assert.equal(route.needs.articleIllustrations, true);
    assert.equal(route.articleIllustrations.minimum, 3);
    assert.equal(route.articleIllustrations.executor, "visual-designer");
    assert.equal(route.articleIllustrations.composeTool, "visualwrite.compose");
    assert.equal(route.articleIllustrations.verifyTool, "visualread.verify");
    assert.deepEqual(route.missing, []);
  }
});

test("a quoted visual name is accepted when the directive is outside the quote", () => {
  const route = resolveContentIntent({ intent: "写一篇文章，并配一张「架构图」" });
  assert.equal(route.artifactKind, "article_visual");
  assert.equal(route.visualForm.mode, "technical");
  assert.deepEqual(route.visualForm.kinds, ["architecture"]);
});

test("pure visual request does not become an article", () => {
  const route = resolveContentIntent({ intent: "做一张 AI 自主经营系统的产品架构图，要求可编辑" });
  assert.equal(route.artifactKind, "pure_visual");
  assert.equal(route.pipeline, "visual.v1");
  assert.equal(route.articleIllustrations, undefined);
});

test("video routes distinguish AI, real footage, talking head and mixed media", () => {
  assert.equal(resolveContentIntent({ intent: "做一条 30 秒的 AI 生成短片", durationSec: 30 }).artifactKind, "video_ai");
  assert.equal(resolveContentIntent({
    intent: "把这段实拍素材剪成 45 秒竖屏视频",
    durationSec: 45,
    attachments: [{ kind: "video", id: "MED-1" }],
  }).artifactKind, "video_edit");
  assert.equal(resolveContentIntent({
    intent: "把这段 20 分钟口播素材精剪成 60 秒",
    durationSec: 60,
    attachments: [{ kind: "video", id: "MED-2", speechLikely: true }],
  }).artifactKind, "video_talking_head");
  assert.equal(resolveContentIntent({
    intent: "保留两段实拍，再插入 AI 生成镜头做混合剪辑",
    durationSec: 60,
    attachments: [{ kind: "video", id: "MED-3" }, { kind: "video", id: "MED-4" }],
  }).artifactKind, "video_mixed");
});

test("video work without duration remains visible as a missing input", () => {
  const route = resolveContentIntent({ intent: "做一条 AI 生成的品牌宣传片" });
  assert.equal(route.artifactKind, "video_ai");
  assert.ok(route.missing.includes("视频总时长（5–180 秒）"));
});

test("ambiguous input may use a bounded model classification but explicit type always wins", () => {
  const area = resolveContentIntent({
    intent: "帮我处理一下这件事",
    modelDecision: { artifactKind: "article", confidence: 0.8, rationale: "Model selected a writing task." },
  });
  assert.equal(area.artifactKind, "article");
  const explicit = resolveContentIntent({
    intent: "帮我处理一下这件事",
    explicitKind: "video_edit",
    modelDecision: { artifactKind: "article", confidence: 0.99, rationale: "ignored" },
    attachments: [{ kind: "video", id: "MED-X" }],
    durationSec: 30,
  });
  assert.equal(explicit.artifactKind, "video_edit");
});
