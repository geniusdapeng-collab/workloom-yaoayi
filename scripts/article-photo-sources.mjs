import { readFile } from "node:fs/promises";
import { discoverArticlePhotos } from "../src/services/article-photo-sources.mjs";

const args = process.argv.slice(2);
const usage = "用法：node scripts/article-photo-sources.mjs --input-file /private/photo-queries.json";
if (args.length === 1 && args[0] === "--help") {
  process.stdout.write(usage + "\n");
} else if (args.length !== 2 || args[0] !== "--input-file") {
  process.stderr.write(usage + "\n");
  process.exitCode = 1;
} else {
  try {
    const input = JSON.parse(await readFile(args[1], "utf8"));
    const result = await discoverArticlePhotos(input);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.results.every(row => row.state === "provider_unavailable")) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(JSON.stringify({ code: error?.code ?? "ARTICLE_PHOTO_QUERY_READ_FAILED", message: "无法读取或处理素材检索请求。" }) + "\n");
    process.exitCode = 1;
  }
}
