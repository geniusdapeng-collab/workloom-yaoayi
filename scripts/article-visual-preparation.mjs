import { resolve } from "node:path";
import { createVideoRuntime } from "../src/video-runtime/index.mjs";

const usage = "用法：node scripts/article-visual-preparation.mjs --input-file /本机私有目录/manifest.json";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log(usage);
} else if (args.length !== 2 || args[0] !== "--input-file" || !args[1]) {
  console.error(usage);
  process.exitCode = 1;
} else {
  let runtime;
  try {
    runtime = createVideoRuntime({ serveWorkbench: false });
    await runtime.start();
    const result = await runtime.prepareArticleIllustrations(resolve(args[1]));
    console.log(JSON.stringify(result));
    if (result.status !== "prepared") process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ code: error.code ?? "ARTICLE_VISUAL_PREPARATION_FAILED" }));
    process.exitCode = 1;
  } finally {
    if (runtime) {
      try { await runtime.stop(); }
      catch { console.error(JSON.stringify({ code: "ARTICLE_VISUAL_RUNTIME_STOP_FAILED" })); process.exitCode = 1; }
    }
  }
}
