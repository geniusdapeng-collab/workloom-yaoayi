import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";
import {
  ARTICLE_ILLUSTRATION_SOURCE_TYPES, ARTICLE_MIN_ILLUSTRATIONS, isMeaningfulIllustrationText, normalizeOpenImageAttribution,
} from "../domain/article-illustration-policy.mjs";
import { ApiError } from "../domain/errors.mjs";
import { hashObject } from "../domain/hash.mjs";
import { scanSensitiveText } from "../domain/policy.mjs";
import { inspectMediaBytes } from "./media-assets.mjs";

export { ARTICLE_MIN_ILLUSTRATIONS, isMeaningfulIllustrationText };

const RECEIPT_SCHEMA = "yaoayi.article-illustration-receipt/v1";
const PROVENANCE_SCHEMA = "yaoayi.article-illustration-provenance/v1";
const RECEIPT_ID = /^AIR-[a-f0-9]{24}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,78}\.(png|jpe?g)$/i;
const SOURCE_TYPES = new Set(ARTICLE_ILLUSTRATION_SOURCE_TYPES);
const WORKSHOP_IDS = ["threadId", "composeEventId", "verifyEventId", "modelEventId"];
const WORKSHOP_DIGESTS = ["sourceSha256", "projectSha256", "recipeSha256", "outputSha256"];
const EDITORIAL_CHANGES = new Set(["crop", "tone", "retouch", "composition"]);
const PACKAGING_CHANGES = new Set(["resize", "format"]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGES = 12;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024;
const SAMPLE_EDGE = 48;
const own = process.getuid?.();

function fail(status, code, message, details) {
  throw new ApiError(status, code, message, details);
}

function badReceipt(field) {
  fail(422, "ARTICLE_ILLUSTRATION_RECEIPT_INVALID", "配图回执字段不齐、无效或与实际素材不一致。", { field });
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shape(value, keys, field) {
  if (!plainObject(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    badReceipt(field);
  }
}

function text(value, max, field, meaningful = false) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)
    || scanSensitiveText(value).length || /\b(?:cookies?|set-cookie|sessionid|session_id)\s*[:=]\s*\S+/i.test(value)
    || (meaningful && !isMeaningfulIllustrationText(value))) {
    badReceipt(field);
  }
  return value.trim();
}

function review(value, field) {
  shape(value, ["approved", "note"], field);
  if (value.approved !== true) badReceipt(field);
  return { approved: true, note: text(value.note, 500, `${field}.note`, true) };
}

function normalizeSource(source, field) {
  const hasAttribution = plainObject(source) && Object.hasOwn(source, "attribution");
  shape(source, hasAttribution ? ["type", "ref", "attribution"] : ["type", "ref"], field);
  const { type } = source;
  if (!SOURCE_TYPES.has(type) || hasAttribution && type !== "licensed") badReceipt(`${field}.type`);
  const ref = text(source.ref, 500, `${field}.ref`);
  if (type === "licensed" && !hasAttribution) badReceipt(`${field}.attribution`);
  if (!hasAttribution) return { type, ref };
  const attribution = normalizeOpenImageAttribution(source.attribution);
  for (const [key, value] of Object.entries(attribution)) text(value, 1000, `${field}.attribution.${key}`);
  return { type, ref, attribution };
}

export function normalizeIllustrationWorkshopProof(value, outputSha256, field = "workshop") {
  shape(value, [...WORKSHOP_IDS, ...WORKSHOP_DIGESTS, "changes"], field);
  const proof = {};
  for (const key of WORKSHOP_IDS) {
    if (typeof value[key] !== "string" || !IDENTIFIER.test(value[key])) badReceipt(field + "." + key);
    proof[key] = value[key];
  }
  for (const key of WORKSHOP_DIGESTS) {
    if (typeof value[key] !== "string" || !SHA256.test(value[key])) badReceipt(field + "." + key);
    proof[key] = value[key];
  }
  if (new Set([proof.composeEventId, proof.verifyEventId, proof.modelEventId]).size !== 3) badReceipt(field + ".events");
  if (proof.outputSha256 !== outputSha256 || proof.sourceSha256 === outputSha256) badReceipt(field + ".outputSha256");
  const changes = value.changes;
  if (!Array.isArray(changes) || changes.length > EDITORIAL_CHANGES.size + PACKAGING_CHANGES.size ||
      new Set(changes).size !== changes.length || !changes.some(change => EDITORIAL_CHANGES.has(change)) ||
      changes.some(change => !EDITORIAL_CHANGES.has(change) && !PACKAGING_CHANGES.has(change))) {
    badReceipt(field + ".changes");
  }
  return { ...proof, changes: [...changes] };
}

function normalizeManifest(value) {
  shape(value, ["schema", "jobId", "requestId", "draftHash", "reviewedBy", "reviewedAt", "renderer", "images"], "manifest");
  if (value.schema !== RECEIPT_SCHEMA) badReceipt("schema");
  if (typeof value.jobId !== "string" || !IDENTIFIER.test(value.jobId)) badReceipt("jobId");
  if (typeof value.requestId !== "string" || !IDENTIFIER.test(value.requestId)) badReceipt("requestId");
  if (typeof value.draftHash !== "string" || !SHA256.test(value.draftHash)) badReceipt("draftHash");
  const reviewedAt = typeof value.reviewedAt === "string" ? new Date(value.reviewedAt) : null;
  if (!reviewedAt || !Number.isFinite(reviewedAt.getTime()) || reviewedAt.toISOString() !== value.reviewedAt) badReceipt("reviewedAt");
  if (!Array.isArray(value.images) || value.images.length < ARTICLE_MIN_ILLUSTRATIONS || value.images.length > MAX_IMAGES) {
    badReceipt("images");
  }
  const renderer = text(value.renderer, 160, "renderer");
  const compositor = /compositor/iu.test(renderer);
  return {
    schema: RECEIPT_SCHEMA,
    jobId: value.jobId,
    requestId: value.requestId,
    draftHash: value.draftHash,
    reviewedBy: text(value.reviewedBy, 120, "reviewedBy"),
    reviewedAt: value.reviewedAt,
    renderer,
    images: value.images.map((row, index) => {
      const field = `images[${index}]`;
      if (compositor && !plainObject(row?.workshop)) badReceipt(field + ".workshop");
      const keys = ["file", "sha256", "sectionKey", "title", "alt", "caption", "source", "rights", "privacy", "relevance"];
      if (compositor) keys.push("workshop");
      shape(row, keys, field);
      if (typeof row.file !== "string" || !FILENAME.test(row.file)) badReceipt(`${field}.file`);
      if (typeof row.sha256 !== "string" || !SHA256.test(row.sha256)) badReceipt(`${field}.sha256`);
      return {
        file: row.file,
        sha256: row.sha256,
        ...(compositor ? { workshop: normalizeIllustrationWorkshopProof(row.workshop, row.sha256, field + ".workshop") } : {}),
        sectionKey: text(row.sectionKey, 160, `${field}.sectionKey`),
        title: text(row.title, 180, `${field}.title`, true),
        alt: text(row.alt, 360, `${field}.alt`, true),
        caption: text(row.caption, 600, `${field}.caption`, true),
        source: normalizeSource(row.source, `${field}.source`),
        rights: review(row.rights, `${field}.rights`),
        privacy: review(row.privacy, `${field}.privacy`),
        relevance: review(row.relevance, `${field}.relevance`),
      };
    }),
  };
}

function privateObject(info, kind) {
  return (kind === "directory" ? info.isDirectory() : info.isFile() && info.nlink === 1)
    && (own === undefined || info.uid === own) && (info.mode & 0o077) === 0;
}

async function checkPrivateDirectory(directory) {
  if (!privateObject(await lstat(directory), "directory")) {
    fail(503, "ARTICLE_ILLUSTRATION_STORAGE_UNSAFE", "配图回执目录必须属于运行用户，并且仅该用户可访问。");
  }
}

async function readPrivateFile(path, maxBytes) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!privateObject(info, "file") || info.size < 1 || info.size > maxBytes) {
      fail(422, "ARTICLE_ILLUSTRATION_FILE_INVALID", "配图回执文件权限、类型或大小无效。");
    }
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) fail(422, "ARTICLE_ILLUSTRATION_FILE_CHANGED", "配图回执文件在读取期间发生变化。");
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
      fail(422, "ARTICLE_ILLUSTRATION_FILE_CHANGED", "配图回执文件在读取期间发生变化。");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readManifest(path) {
  const bytes = await readPrivateFile(path, MAX_MANIFEST_BYTES);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { badReceipt("manifest"); }
  return normalizeManifest(value);
}

function byteHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function assertEditorialImageBytes(bytes, { mime } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_IMAGE_BYTES || !IMAGE_TYPES.has(mime)) {
    fail(422, "ARTICLE_ILLUSTRATION_IMAGE_INVALID", "配图必须是可打开的静态图片，且大小符合配图限制。");
  }
  const { width, height } = inspectMediaBytes(bytes, mime);
  if (Math.min(width, height) < 240 || Math.max(width, height) < 320) {
    fail(422, "ARTICLE_ILLUSTRATION_IMAGE_TOO_SMALL", "配图应至少为 320×240 像素（横竖均可）。");
  }
  let sample;
  try {
    sample = await sharp(bytes, { failOn: "warning", limitInputPixels: 32_000_000 })
      .autoOrient()
      .flatten({ background: "#ffffff" })
      .resize(SAMPLE_EDGE, SAMPLE_EDGE, { fit: "fill" })
      .toColourspace("srgb")
      .raw()
      .toBuffer();
  } catch {
    fail(422, "ARTICLE_ILLUSTRATION_IMAGE_INVALID", "配图像素无法完整解码。");
  }
  const pixels = SAMPLE_EDGE ** 2;
  if (sample.length !== pixels * 3) {
    fail(422, "ARTICLE_ILLUSTRATION_IMAGE_INVALID", "配图像素无法完整解码。");
  }
  const sum = [0, 0, 0];
  const squares = [0, 0, 0];
  for (let offset = 0; offset < sample.length; offset += 3) {
    for (let channel = 0; channel < 3; channel++) {
      const value = sample[offset + channel];
      sum[channel] += value;
      squares[channel] += value ** 2;
    }
  }
  if (!sum.some((total, channel) => squares[channel] / pixels - (total / pixels) ** 2 >= 81)) {
    fail(422, "ARTICLE_ILLUSTRATION_IMAGE_EMPTY", "配图为空白、透明或缺少可辨认的画面。");
  }
  return { width, height, pixelHash: byteHash(sample), pixelSample: sample };
}

export function editorialImagesMatch(left, right) {
  if (left.pixelHash === right.pixelHash) return true;
  // A different codec or quality setting can change the digest without changing the image.
  const a = left.pixelSample;
  const b = right.pixelSample;
  const length = SAMPLE_EDGE ** 2 * 3;
  if (a.length !== length || b.length !== length) return false;
  let squaredError = 0;
  for (let index = 0; index < length; index++) {
    squaredError += (a[index] - b[index]) ** 2;
  }
  return squaredError / length <= 36;
}

async function verifyImages(directory, manifest, article) {
  const sections = article ? new Set(article.sections?.map(section => section.key)) : null;
  const seenFiles = new Set();
  const seenHashes = new Set();
  const images = [];
  for (const [index, row] of manifest.images.entries()) {
    const field = `images[${index}]`;
    const file = row.file.toLowerCase();
    if (sections && !sections.has(row.sectionKey)) badReceipt(`${field}.sectionKey`);
    if (seenFiles.has(file) || seenHashes.has(row.sha256)) badReceipt(`${field}.duplicate`);
    const mime = file.endsWith(".png") ? "image/png" : "image/jpeg";
    const bytes = await readPrivateFile(join(directory, row.file), MAX_IMAGE_BYTES);
    if (byteHash(bytes) !== row.sha256) badReceipt(`${field}.sha256`);
    const metrics = await assertEditorialImageBytes(bytes, { mime });
    if (images.some(image => editorialImagesMatch(image.metrics, metrics))) badReceipt(`${field}.duplicate`);
    seenFiles.add(file);
    seenHashes.add(row.sha256);
    images.push({ row, bytes, mime, metrics });
  }
  return images;
}

export function articleIllustrationReceiptDirectory({ rootDir, env = process.env }) {
  const stateFile = resolve(rootDir, env.DATA_FILE || "var/state.json");
  return resolve(rootDir, env.ARTICLE_ILLUSTRATION_RECEIPTS_DIR || join(dirname(stateFile), "article-illustration-receipts"));
}

export function createArticleIllustrationReceiptVerifier({ directory }) {
  const root = resolve(directory);
  return async ({ jobId, requestId, draftHash, article, input }) => {
    if (!plainObject(input) || Object.keys(input).length !== 1 || typeof input.receiptId !== "string" || !RECEIPT_ID.test(input.receiptId)) {
      fail(400, "ARTICLE_ILLUSTRATION_RECEIPT_ID_INVALID", "请提供本机已登记的有效配图回执 ID。");
    }
    const { receiptId } = input;
    const receiptDirectory = join(root, receiptId);
    try {
      await checkPrivateDirectory(root);
      await checkPrivateDirectory(receiptDirectory);
      const manifest = await readManifest(join(receiptDirectory, "receipt.json"));
      const receiptHash = hashObject(manifest);
      if (receiptId !== `AIR-${receiptHash.slice(0, 24)}`) badReceipt("receiptId");
      if (manifest.jobId !== jobId || manifest.requestId !== requestId || manifest.draftHash !== draftHash
        || !Array.isArray(article?.sections)) {
        fail(409, "ARTICLE_ILLUSTRATION_DRAFT_MISMATCH", "配图回执与当前冻结正文或本轮请求不匹配。");
      }
      const verified = await verifyImages(receiptDirectory, manifest, article);
      return {
        receiptId,
        receiptHash,
        images: verified.map(({ row, bytes, mime, metrics: { pixelHash, width, height } }) => {
          const { title, alt, caption, sectionKey, sha256, source, rights, privacy, relevance } = row;
          return {
            bytes, mime, title, alt, caption, sha256, sectionKey,
            provenance: {
              schema: PROVENANCE_SCHEMA,
              receiptId, receiptHash, jobId, requestId, draftHash, sectionKey,
              reviewedBy: manifest.reviewedBy,
              reviewedAt: manifest.reviewedAt,
              renderer: manifest.renderer,
              source, rights, privacy, relevance, pixelHash, width, height,
              ...(row.workshop ? { workshop: row.workshop } : {}),
            },
          };
        }),
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error?.code === "ENOENT") fail(404, "ARTICLE_ILLUSTRATION_RECEIPT_NOT_FOUND", "配图回执尚未登记或文件未齐备。");
      fail(503, "ARTICLE_ILLUSTRATION_STORAGE_UNAVAILABLE", "无法安全读取本机配图回执。");
    }
  };
}

// Only the local operator stages a receipt. The HTTP route accepts the ID and
// never imports a client-provided manifest or workstation file path.
export async function registerArticleIllustrationReceipt({ directory, inputFile }) {
  const sourceDirectory = dirname(inputFile);
  const root = resolve(directory);
  await checkPrivateDirectory(sourceDirectory);
  const manifest = await readManifest(inputFile);
  const receiptHash = hashObject(manifest);
  const receiptId = `AIR-${receiptHash.slice(0, 24)}`;
  const target = join(root, receiptId);
  const verified = await verifyImages(sourceDirectory, manifest);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await checkPrivateDirectory(root);
  const staging = await mkdtemp(join(root, ".incoming-"));
  try {
    for (const { row, bytes } of verified) {
      await writeFile(join(staging, row.file), bytes, { mode: 0o600, flag: "wx" });
    }
    await writeFile(join(staging, "receipt.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    try {
      await rename(staging, target);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
      await checkPrivateDirectory(target);
      const previous = await readManifest(join(target, "receipt.json"));
      if (hashObject(previous) !== receiptHash) badReceipt("receiptId");
      await verifyImages(target, previous);
    }
    return { receiptId, receiptHash, jobId: manifest.jobId, imageCount: verified.length };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
