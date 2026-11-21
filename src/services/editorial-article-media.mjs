import { ApiError, PolicyError } from "../domain/errors.mjs";
import { ARTICLE_MIN_ILLUSTRATIONS } from "../domain/article-illustration-policy.mjs";
import { isEditorialArticle, requireArticleIllustrationRefs } from "../domain/editorial.mjs";
import { assertEditorialImageBytes, editorialImagesMatch } from "./article-illustration-receipts.mjs";

export async function verifyEditorialArticleMedia(state, document, mediaAssets) {
  if (!isEditorialArticle(document)) return;
  const refs = requireArticleIllustrationRefs(state, document);
  if (typeof mediaAssets?.openVerifiedAsset !== "function") {
    throw new ApiError(503, "MEDIA_VERIFICATION_UNAVAILABLE", "核对正文图片需要实际媒体存储。");
  }
  const distinct = [];
  for (const ref of refs) {
    const opened = await mediaAssets.openVerifiedAsset(ref.assetId, {
      state, sha256: ref.sha256, forceVerify: true,
    });
    try {
      const visual = await assertEditorialImageBytes(await opened.handle.readFile(), { mime: opened.asset.mime });
      if (!distinct.some(previous => editorialImagesMatch(previous, visual))) distinct.push(visual);
    } finally {
      await opened.handle.close();
    }
  }
  if (distinct.length < ARTICLE_MIN_ILLUSTRATIONS) {
    throw new PolicyError("ARTICLE_ILLUSTRATIONS_REQUIRED", "同一张图片的重复编码不能计为多张正文配图。",
      [{ minimum: ARTICLE_MIN_ILLUSTRATIONS, eligible: distinct.length }]);
  }
}
