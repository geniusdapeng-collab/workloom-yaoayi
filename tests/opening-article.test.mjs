import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { documentBlocksFromText } from "../public/publication-view.js";
import { timelessReviewProblem, TIMELESS_CRITERIA } from "../src/domain/content-ops-timeless.mjs";

const articlePath = new URL("../content/articles/001-ai-autonomous-business-operating-model.md", import.meta.url);
const reviewPath = new URL("../content/articles/001-ai-autonomous-business-operating-model.review.json", import.meta.url);

test("opening article is complete, structured and explicitly bounded in time", async () => {
  const source = await readFile(articlePath, "utf8");
  const lines = source.split("\n");
  const title = lines.find(line => line.startsWith("# "))?.slice(2);
  const body = lines.slice(lines.findIndex(line => line.startsWith("## "))).join("\n").trim();
  const blocks = documentBlocksFromText(body);
  assert.equal(title, "AI自主经营系统的经营底座：从工具集合走向生意经营模型");
  assert.ok([...body].length >= 6000);
  assert.ok(blocks.length >= 100);
  assert.ok(blocks.some(block => block.type === "heading"));
  assert.ok(blocks.some(block => block.type === "list"));
  assert.ok(blocks.some(block => block.type === "quote"));
  assert.match(body, /2026 年 11 月/);
  assert.match(body, /在我的经验里|我所说的生意经营模型/);
  assert.match(body, /这套方法什么时候需要重写/);
  assert.match(body, /眼观六路/);
  assert.match(body, /手抓四环/);
  assert.doesNotMatch(body, /TODO|待补充|Lorem ipsum/i);
});

test("opening article's timeless review is complete and matches the stored metadata", async () => {
  const review = JSON.parse(await readFile(reviewPath, "utf8"));
  assert.equal(review.slug, "ai-autonomous-business-operating-model");
  assert.deepEqual(review.claimIds, ["C002"]);
  assert.equal(timelessReviewProblem(review.timelessReview), null);
  assert.deepEqual(review.timelessReview.criteria.map(row => row.id), TIMELESS_CRITERIA.map(row => row.id));
  assert.ok(review.timelessReview.decayTriggers.length >= 4);
});
