import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";
import {
  assertEditorialImageBytes, createArticleIllustrationReceiptVerifier, registerArticleIllustrationReceipt,
} from "../src/services/article-illustration-receipts.mjs";

const exec = promisify(execFile);
const rootDir = resolve(import.meta.dirname, "..");
const binding = {
  jobId: "CDJ-illustration-test",
  requestId: "CDI-frozen-illustration-test",
  draftHash: "1".repeat(64),
};
const article = { sections: [{ key: "morning" }, { key: "afternoon" }, { key: "evening" }] };
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const approved = note => ({ approved: true, note });
const privateWrite = (path, data) => writeFile(path, data, { mode: 0o600 });

async function sampleImage(index, compressionLevel = 6) {
  const swatch = ["#b44820", "#386d9c", "#00553c"][index];
  const box = await sharp({ create: { width: 200, height: 160, channels: 3, background: swatch } }).png().toBuffer();
  return sharp({ create: { width: 640, height: 400, channels: 3, background: "#f5efe5" } })
    .composite([{ input: box, left: 140 + 20 * index, top: 80 + 10 * index }])
    .png({ compressionLevel })
    .toBuffer();
}

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "yaoayi-illustration-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = join(base, "source");
  const directory = join(base, "receipts");
  const inputFile = join(source, "manifest.json");
  await mkdir(source, { mode: 0o700 });
  const images = [];
  for (const [index, section] of article.sections.entries()) {
    const file = `sample-${index}.png`;
    const bytes = await sampleImage(index);
    await privateWrite(join(source, file), bytes);
    images.push({
      file, sha256: sha256(bytes), sectionKey: section.key,
      title: `小院光线中的长椅 ${index + 1}`,
      alt: `小院墙边一条光照充足的长椅 ${index + 1}`,
      caption: `本节展示小院长椅与墙面光线 ${index + 1}`,
      source: { type: "owned", ref: `test-original-${index + 1}` },
      rights: approved("由小院素材所有权人授权用于本文"),
      privacy: approved("照片没有包含可辨认人物或识别信息"),
      relevance: approved("长椅及光线对应冻结正文中的这一节"),
    });
  }
  const manifest = {
    schema: "yaoayi.article-illustration-receipt/v1",
    ...binding,
    reviewedBy: "测试审核员",
    reviewedAt: "2026-11-21T00:00:00.000Z",
    renderer: "测试配图制作工位",
    images,
  };
  const save = () => privateWrite(inputFile, JSON.stringify(manifest));
  await save();
  const verifier = createArticleIllustrationReceiptVerifier({ directory });
  return {
    directory, source, inputFile, manifest, save,
    register: () => registerArticleIllustrationReceipt({ directory, inputFile }),
    verify: (receiptId, overrides = {}) => verifier({ ...binding, article, input: { receiptId }, ...overrides }),
  };
}

test("local command stages a private receipt and verifies each real image against the frozen article", async t => {
  const setup = await fixture(t);
  const run = () => exec(process.execPath, [join(rootDir, "scripts/article-illustration-receipt.mjs"), "--input-file", setup.inputFile], {
    env: { ...process.env, ARTICLE_ILLUSTRATION_RECEIPTS_DIR: setup.directory },
  });
  const { receiptId, receiptHash, jobId, imageCount } = JSON.parse((await run()).stdout);
  assert.match(receiptId, /^AIR-[a-f0-9]{24}$/);
  assert.equal(jobId, binding.jobId);
  assert.equal(imageCount, 3);
  assert.equal((await stat(setup.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(setup.directory, receiptId, "receipt.json"))).mode & 0o777, 0o600);
  const [left, right] = await Promise.all([run(), run()]);
  assert.equal(JSON.parse(left.stdout).receiptId, receiptId);
  assert.equal(JSON.parse(right.stdout).receiptId, receiptId);
  assert.deepEqual(await readdir(setup.directory), [receiptId]);
  const verified = await setup.verify(receiptId);
  assert.equal(verified.receiptHash, receiptHash);
  for (const [index, image] of verified.images.entries()) {
    const expected = setup.manifest.images[index];
    assert.equal(image.sha256, sha256(image.bytes));
    assert.deepEqual(image.bytes, await readFile(join(setup.source, expected.file)));
    assert.equal(image.mime, "image/png");
    assert.equal(image.sectionKey, expected.sectionKey);
    assert.equal(image.provenance.receiptHash, receiptHash);
    assert.equal(image.provenance.width, 640);
    assert.equal(image.provenance.height, 400);
    assert.equal(image.provenance.relevance.approved, true);
    assert.equal(Object.hasOwn(image.provenance, "file"), false);
  }
  assert.equal(new Set(verified.images.map(image => image.provenance.pixelHash)).size, 3);
});

test("verifier rejects HTTP provenance and path input, unknown receipt, another draft, and missing frozen section", async t => {
  const setup = await fixture(t);
  const { receiptId } = await setup.register();
  await assert.rejects(setup.verify(receiptId, { input: { receiptId, rights: true } }), { code: "ARTICLE_ILLUSTRATION_RECEIPT_ID_INVALID" });
  await assert.rejects(setup.verify("../receipt.json"), { code: "ARTICLE_ILLUSTRATION_RECEIPT_ID_INVALID" });
  await assert.rejects(setup.verify(`AIR-${"f".repeat(24)}`), { code: "ARTICLE_ILLUSTRATION_RECEIPT_NOT_FOUND" });
  for (const override of [{ requestId: "other-run" }, { jobId: "other-job" }, { draftHash: "2".repeat(64) }]) {
    await assert.rejects(setup.verify(receiptId, override), { code: "ARTICLE_ILLUSTRATION_DRAFT_MISMATCH" });
  }
  await assert.rejects(setup.verify(receiptId, { article: { sections: article.sections.slice(0, 2) } }),
    { code: "ARTICLE_ILLUSTRATION_RECEIPT_INVALID", details: { field: "images[2].sectionKey" } });
});

test("registration rejects missing rights, duplicate encodings and incomplete packs", async t => {
  const setup = await fixture(t);
  setup.manifest.images[0].rights.approved = false;
  await setup.save();
  await assert.rejects(setup.register(), { code: "ARTICLE_ILLUSTRATION_RECEIPT_INVALID", details: { field: "images[0].rights" } });
  setup.manifest.images[0].rights.approved = true;
  const duplicate = await sampleImage(0, 0);
  assert.notEqual(sha256(duplicate), setup.manifest.images[0].sha256);
  await privateWrite(join(setup.source, setup.manifest.images[2].file), duplicate);
  setup.manifest.images[2].sha256 = sha256(duplicate);
  await setup.save();
  await assert.rejects(setup.register(), { code: "ARTICLE_ILLUSTRATION_RECEIPT_INVALID", details: { field: "images[2].duplicate" } });
  const reencoded = await sharp(duplicate).jpeg({ quality: 80 }).toBuffer();
  setup.manifest.images[2].file = "sample-2.jpg";
  setup.manifest.images[2].sha256 = sha256(reencoded);
  await privateWrite(join(setup.source, "sample-2.jpg"), reencoded);
  await setup.save();
  await assert.rejects(setup.register(), { code: "ARTICLE_ILLUSTRATION_RECEIPT_INVALID", details: { field: "images[2].duplicate" } });
  setup.manifest.images.pop();
  await setup.save();
  await assert.rejects(setup.register(), { code: "ARTICLE_ILLUSTRATION_RECEIPT_INVALID", details: { field: "images" } });
});

test("licensed photos require canonical open attribution, while owned sources retain the local reference contract", async t => {
  const setup = await fixture(t);
  const source = setup.manifest.images[0].source = {
    type: "licensed", ref: "https://commons.wikimedia.org/wiki/File:Isolated_fixture.jpg",
  };
  await setup.save();
  await assert.rejects(setup.register(), {
    code: "ARTICLE_ILLUSTRATION_RECEIPT_INVALID", details: { field: "images[0].source.attribution" },
  });
  source.ref = "private-source-reference";
  await setup.save();
  await assert.rejects(setup.register(), {
    code: "ARTICLE_ILLUSTRATION_RECEIPT_INVALID", details: { field: "images[0].source.attribution" },
  });
  source.attribution = {
    landingUrl: "https://commons.wikimedia.org/wiki/File:Isolated_fixture.jpg", credit: "Isolated photographer", licenseId: "CC-BY-SA-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-nc/4.0/", modifications: "Cropped for the article",
  };
  await setup.save();
  await assert.rejects(setup.register(), { code: "ARTICLE_IMAGE_LICENSE_INVALID" });
  source.attribution.licenseUrl = "https://creativecommons.org/licenses/by-sa/4.0/deed.en";
  await setup.save();
  const result = await setup.verify((await setup.register()).receiptId);
  assert.deepEqual(result.images[0].provenance.source.attribution, {
    ...source.attribution, licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  });
  assert.equal(result.images[1].provenance.source.type, "owned");
  assert.equal(Object.hasOwn(result.images[1].provenance.source, "attribution"), false);
});

test("registered receipt rejects altered bytes, loose permissions and symbolic links", async t => {
  const setup = await fixture(t);
  const { receiptId } = await setup.register();
  const image = setup.manifest.images[0];
  const privateImage = join(setup.directory, receiptId, image.file);
  await privateWrite(privateImage, await sampleImage(1));
  await assert.rejects(setup.verify(receiptId), { code: "ARTICLE_ILLUSTRATION_RECEIPT_INVALID", details: { field: "images[0].sha256" } });
  await assert.rejects(setup.register(), { code: "ARTICLE_ILLUSTRATION_RECEIPT_INVALID", details: { field: "images[0].sha256" } });
  await chmod(privateImage, 0o644);
  await assert.rejects(setup.verify(receiptId), { code: "ARTICLE_ILLUSTRATION_FILE_INVALID" });
  await rm(privateImage);
  await symlink(join(setup.source, image.file), privateImage);
  await assert.rejects(setup.verify(receiptId), { code: "ARTICLE_ILLUSTRATION_STORAGE_UNAVAILABLE" });
});

test("image gate rejects transparent, malformed and tiny bytes and accepts static JPEG", async () => {
  const empty = await sharp({ create: { width: 640, height: 400, channels: 4, background: "#119f5700" } }).png().toBuffer();
  const tiny = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#123456" } }).png().toBuffer();
  const actual = await sampleImage(0);
  const jpeg = await sharp(actual).jpeg().toBuffer();
  await assert.rejects(assertEditorialImageBytes(empty, { mime: "image/png" }), { code: "ARTICLE_ILLUSTRATION_IMAGE_EMPTY" });
  await assert.rejects(assertEditorialImageBytes(tiny, { mime: "image/png" }), { code: "ARTICLE_ILLUSTRATION_IMAGE_TOO_SMALL" });
  await assert.rejects(assertEditorialImageBytes(actual.subarray(0, -1), { mime: "image/png" }), { code: "MEDIA_INVALID_FORMAT" });
  await assert.rejects(assertEditorialImageBytes(actual, { mime: "image/jpeg" }), { code: "MEDIA_INVALID_FORMAT" });
  assert.equal((await assertEditorialImageBytes(jpeg, { mime: "image/jpeg" })).width, 640);
});
