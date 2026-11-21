import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { hashObject } from "../src/domain/hash.mjs";

const scenes = [
  {
    name: "院门",
    art: '<path fill="#5a7953" d="M0 390L250 180l190 160L650 190l250 190v220H0z"/><path fill="#e5b58c" d="M205 600V220h430v380z"/><path fill="#813d2d" d="M320 600V310q100-80 200 0v290z"/>',
  },
  {
    name: "手冲",
    art: '<path fill="#b28360" d="M0 410h900v190H0z"/><path fill="#eddbc4" d="M525 270h180l-40 185H565z"/><path fill="#273e49" d="M120 440l65-240q180-30 240 95l110 40-15 30-100-20-30 95z"/>',
  },
  {
    name: "山货",
    art: '<path fill="#876345" d="M0 340h900v260H0z"/><ellipse cx="450" cy="455" rx="285" ry="85" fill="#e4bb83"/><path fill="#d06b3b" d="M280 445q-50-120 55-110 105-60 135 60-75 140-190 50z"/><path fill="#64553a" d="M440 470q-30-120 90-110 95-5 100 90-15 80-190 20z"/>',
  },
];

let fixtureImages;

export function articleIllustrationImages() {
  fixtureImages ??= Promise.all(scenes.map(async ({ name, art }) => {
    const bytes = await sharp(Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 900 600"><defs><linearGradient id="sky"><stop stop-color="#e1cda6"/><stop offset="1" stop-color="#847f65"/></linearGradient></defs><rect width="900" height="600" fill="url(#sky)"/>${art}</svg>`,
    )).png().toBuffer();
    return {
      bytes,
      mime: "image/png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      title: name,
      alt: `${name}场景的隔离测试配图`,
      caption: `${name}场景测试素材`,
    };
  }));
  return fixtureImages;
}

export async function fixtureArticleIllustrationVerifier(binding) {
  const images = await articleIllustrationImages();
  return {
    receiptId: binding.input.receiptId,
    receiptHash: hashObject({ ...binding.input, jobId: binding.jobId, draftHash: binding.draftHash }),
    images: images.map((image, index) => ({
      ...image,
      sectionKey: binding.article.sections[index].key,
      provenance: {
        sourceKind: "generated",
        sourceHash: image.sha256,
        nativeDesignId: `${binding.input.receiptId}-${index + 1}`,
        disclosure: "隔离测试的 AI 合成示意",
      },
    })),
  };
}

export async function bindFixtureArticleIllustrations(director, job, ctx) {
  assert.equal(job.status, "needs_input");
  assert.equal(job.editorialIllustration?.status, "waiting_for_images");
  return director.bindArticleIllustrations(job.id, {
    receiptId: `AIR-${hashObject(job.editorialIllustration.requestId).slice(0, 24)}`,
  }, { ...ctx, ifMatch: job.etag });
}

export async function processIllustratedArticle(director, jobId, ctx) {
  const waiting = await director.processJob(jobId);
  if (waiting.editorialIllustration?.status !== "waiting_for_images") return waiting;
  await bindFixtureArticleIllustrations(director, waiting, ctx);
  return director.processJob(jobId);
}
