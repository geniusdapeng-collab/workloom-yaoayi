import { resolve } from "node:path";
import {
  articleIllustrationReceiptDirectory,
  registerArticleIllustrationReceipt,
} from "../src/services/article-illustration-receipts.mjs";
import { ApiError } from "../src/domain/errors.mjs";

const help = "用法：node scripts/article-illustration-receipt.mjs --input-file /私有目录/manifest.json";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  process.stdout.write(`${help}\n`);
} else if (args.length !== 2 || args[0] !== "--input-file" || !args[1]) {
  process.stderr.write(`${help}\n`);
  process.exitCode = 1;
} else {
  try {
    const receipt = await registerArticleIllustrationReceipt({
      directory: articleIllustrationReceiptDirectory({ rootDir: resolve(import.meta.dirname, "..") }),
      inputFile: resolve(args[1]),
    });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "ARTICLE_ILLUSTRATION_RECEIPT_IO_ERROR";
    const field = error instanceof ApiError ? error.details?.field : undefined;
    process.stderr.write(`${JSON.stringify({ code, field })}\n`);
    process.exitCode = 1;
  }
}
