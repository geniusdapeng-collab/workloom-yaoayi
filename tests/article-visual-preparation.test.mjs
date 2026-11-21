import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { compositorPhotoChanges, createArticleVisualPreparationReviewer } from "../src/services/article-visual-preparation.mjs";
import { SCOPE } from "../src/video-runtime/config.mjs";

const sha = (kind, bytes) => createHash(kind).update(bytes).digest("hex");
const fingerprint = "3".repeat(64);
const privateFaceScan = { engine: "apple-vision-face-rectangles", faceCount: 0, revision: 3 };
const answer = { decision: "accept", captionAccurate: true, relatedToSection: true,
  referenceFraming: true, reason: "配图展示手冲咖啡步骤，图注保留纪实参考定位。" };

async function fixture(t, deps = {}) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "yaoayi-photo-review-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = await sharp({ create: { width: 1620, height: 1080, channels: 3, background: "#d09061" } }).jpeg().toBuffer();
  const path = join(directory, "fixture.jpg");
  await writeFile(path, bytes, { mode: 0o600 });
  const body = { jobId: "CDJ-test", requestId: "CDI-test", draftHash: "4".repeat(64), sectionKey: "cup",
    sourceSha256: sha("sha256", bytes), caption: "手冲咖啡步骤纪实参考。铜壶倒水，白瓷杯在滤杯旁。",
  };
  const attribution = { landingUrl: "https://commons.wikimedia.org/wiki/File:Isolated-coffee.jpg", credit: "Isolated Photographer",
    title: "Isolated coffee image", licenseId: "CC-BY-SA-4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    modifications: "本文局部裁切和调色，改作沿用 CC BY-SA 4.0。" };
  const authority = { ...attribution, sha1: sha("sha1", bytes), size: bytes.length, width: 1620, height: 1080, mime: "image/jpeg" };
  const binding = { ...body, article: { sections: [{ key: "cup", title: "小院里的手冲咖啡", body: "用咖啡滤杯记下手冲节奏。" }] } };
  const recorded = [], modelCalls = [];
  const review = createArticleVisualPreparationReviewer({
    binding, sourceDirectory: directory, outputDirectory: directory, sourceReader: async () => authority,
    inspectPrivacy: async () => privateFaceScan, recordReview: async record => recorded.push(record),
    reviewModel: async request => {
      modelCalls.push(request);
      return { eventId: "E-4242", responseHash: "d".repeat(64), value: { ...answer } };
    },
    ...deps,
  });
  const input = { scope: { tenantId: SCOPE.tenantId, workspaceId: SCOPE.workspaceId },
    threadId: "thr-fixture", fingerprint, step: {
      objectType: "visual_asset", action: "visualwrite.compose", tool: "visualwrite.compose",
      params: { out_dir: directory, has_portrait: false, has_third_party_asset: true, source_evidence: { ...body, attribution },
        recipe: { recipe_version: 1, name: "yaoayi-photo-fixture", canvas: { width: 1536, height: 944, resolution: 72 },
          layers: [
            { type: "image", name: "手冲咖啡", source: path, x: 0, y: -48, width: 1536, height: 1024, opacity: 1 },
            { type: "solid", name: "调整色调", color: "#D5CABC", x: 0, y: 0, width: 1536, height: 944, opacity: 0.04 },
          ], exports: [{ format: "png", path: "yaoayi-photo-fixture.png" }] },
      },
    } };
  return { review, input, recorded, modelCalls, path, authority };
}

test("license, true source bytes, native model and no-face evidence admit only the exact low-risk preparation", async t => {
  const f = await fixture(t);
  f.input.step.params.source_evidence.attribution.modifications = "已移除画面里的包装及车辆品牌。";
  const accepted = await f.review(f.input);
  assert.equal(accepted.decision, "approved");
  assert.equal(accepted.fingerprint, fingerprint);
  assert.equal(accepted.modelEventId, "E-4242");
  assert.equal(accepted.evidenceHash, f.recorded[0].evidenceHash);
  assert.equal(f.recorded[0].sourceSha256, f.input.step.params.source_evidence.sourceSha256);
  assert.doesNotMatch(f.modelCalls[0].prompt, new RegExp(f.path));
  assert.doesNotMatch(f.modelCalls[0].prompt, /已移除|车辆品牌/u);
  assert.equal(f.recorded[0].attribution.modifications, "按正文版式裁剪并轻度调色。本图改作沿用 CC BY-SA 4.0。");
  assert.match(f.modelCalls[0].prompt, /不可假称亲眼见到/);
});

test("the native geometry reports only tone if the frame fits, without inferring an object was removed", async t => {
  const { input } = await fixture(t);
  const { recipe } = input.step.params;
  assert.deepEqual(compositorPhotoChanges(recipe, "CC0-1.0"), {
    changes: ["crop", "tone"], modifications: "按正文版式裁剪并轻度调色。",
  });
  recipe.layers[0].y = 0;
  recipe.layers[0].height = recipe.canvas.height;
  assert.deepEqual(compositorPhotoChanges(recipe, "CC-BY-SA-4.0"), {
    changes: ["tone"], modifications: "按正文版式轻度调色。本图改作沿用 CC BY-SA 4.0。",
  });
});

test("no model call occurs for unauthoritative license, mismatched bytes, faces, out-of-scope role or writable path", async t => {
  const f = await fixture(t);
  const wrongSpace = { ...f.input, scope: { ...f.input.scope, workspaceId: "other" } };
  assert.equal((await f.review(wrongSpace)).code, "ARTICLE_VISUAL_SCOPE_MISMATCH");
  f.authority.credit = "Wrong photographer";
  assert.equal((await f.review(f.input)).code, "ARTICLE_VISUAL_LICENSE_MISMATCH");
  f.authority.credit = "Isolated Photographer";
  const claim = f.input.step.params.source_evidence;
  const original = claim.sourceSha256;
  claim.sourceSha256 = "9".repeat(64);
  assert.equal((await f.review(f.input)).code, "ARTICLE_VISUAL_SOURCE_BYTES_MISMATCH");
  claim.sourceSha256 = original;
  await chmod(f.path, 0o644);
  assert.equal((await f.review(f.input)).code, "ARTICLE_VISUAL_SOURCE_UNVERIFIED");
  const face = await fixture(t, { inspectPrivacy: async () => ({ ...privateFaceScan, faceCount: 1 }),
    reviewModel: async () => { assert.fail("Portrait source must stop before paid model review"); } });
  assert.equal((await face.review(face.input)).code, "ARTICLE_VISUAL_PORTRAIT_REVIEW_REQUIRED");
  assert.equal(f.modelCalls.length, 0);
});

test("uncertain model or a source edit between review and native composition remains blocked", async t => {
  const invalid = await fixture(t, {
    reviewModel: async () => ({ eventId: "not-a-native-event", responseHash: "d".repeat(64), value: answer }),
  });
  assert.equal((await invalid.review(invalid.input)).code, "ARTICLE_VISUAL_MODEL_RECEIPT_REQUIRED");
  const denied = await fixture(t, {
    reviewModel: async () => ({ eventId: "E-1000", responseHash: "d".repeat(64),
      value: { ...answer, decision: "revise", relatedToSection: false } }),
  });
  assert.equal((await denied.review(denied.input)).code, "ARTICLE_VISUAL_REVISE_REQUIRED");
  const tampered = await fixture(t, {
    reviewModel: async () => {
      await writeFile(tampered.path, Buffer.alloc(tampered.authority.size, 7));
      return { eventId: "E-1001", responseHash: "d".repeat(64), value: answer };
    },
  });
  assert.equal((await tampered.review(tampered.input)).code, "ARTICLE_VISUAL_SOURCE_FILE_CHANGED");
});
