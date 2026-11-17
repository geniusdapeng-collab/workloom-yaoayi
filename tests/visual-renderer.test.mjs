import test from "node:test";
import assert from "node:assert/strict";
import { mermaidSource, normalizeVisualPlan, renderVisualPng, renderVisualSvg } from "../src/services/visual-renderer.mjs";

const plan = normalizeVisualPlan({
  visuals: [{
    kind: "architecture",
    title: "内容生产架构",
    alt: "内容总控连接文章、视觉和视频生产线的架构图",
    caption: "图 1",
    nodes: [
      { id: "director", label: "内容总控" },
      { id: "article", label: "文章生产线" },
      { id: "video", label: "视频生产线" },
    ],
    edges: [
      { from: "director", to: "article", label: "文章 Job" },
      { from: "director", to: "video", label: "视频 Job" },
    ],
  }],
});

test("visual contract produces editable Mermaid source and deterministic SVG", () => {
  const spec = plan.visuals[0];
  const source = mermaidSource(spec);
  assert.match(source, /flowchart LR/);
  assert.match(source, /director\["内容总控"\]/);
  const first = renderVisualSvg(spec);
  const second = renderVisualSvg(spec);
  assert.equal(first.sha256, second.sha256);
  assert.match(first.bytes.toString("utf8"), /role="img"/);
  assert.match(first.bytes.toString("utf8"), /文章生产线/);
});

test("visual contract renders a real PNG", async () => {
  const result = await renderVisualPng(plan.visuals[0]);
  assert.equal(result.mime, "image/png");
  assert.deepEqual([...result.bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
