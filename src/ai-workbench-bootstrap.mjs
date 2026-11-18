import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { AI_WORKBENCH_SERVER, buildAiWorkbenchConfig } from "./ai-workbench-config.mjs";

const execFileAsync = promisify(execFile);
const CODEX_BEGIN = "# >>> yaoayi-workbench generated section; rerun bootstrap instead of editing this block >>>";
const CODEX_END = "# <<< yaoayi-workbench generated section <<<";
const MAX_CONFIG_BYTES = 1024 * 1024;
const CLIENTS = new Set(["all", "codex", "qoder", "workbuddy", "generic", "qianwen"]);

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readOptional(file, maximum = MAX_CONFIG_BYTES) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 0 || info.size > maximum) {
      fail("WORKBENCH_TARGET_INVALID", "Existing client configuration must be an ordinary bounded file.");
    }
    return await readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code === "WORKBENCH_TARGET_INVALID") throw error;
    fail("WORKBENCH_TARGET_INVALID", "Existing client configuration could not be read safely.");
  }
}

async function atomicWrite(file, bytes, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporary, mode);
    await rename(temporary, file);
    await chmod(file, mode);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (error?.code?.startsWith?.("WORKBENCH_")) throw error;
    fail("WORKBENCH_WRITE_FAILED", "Generated client configuration could not be written atomically.");
  }
}

async function backupIfChanged(file, previous, backupRoot) {
  if (previous === null) return null;
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const base = path.basename(file);
  const target = path.join(backupRoot, `${base}.${new Date().toISOString().replaceAll(":", "-")}.bak`);
  await copyFile(file, target);
  await chmod(target, 0o600);
  return target;
}

function tomlSectionNames(text) {
  const lines = text.split(/\r?\n/u);
  const headers = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^\s*\[(mcp_servers\.yaoayi-video(?:\.[^\]]+)?)\]\s*(?:#.*)?$/u);
    if (match) headers.push({ index, name: match[1] });
  }
  return { lines, headers };
}

export function mergeCodexMcpConfig(existing, generated) {
  if (typeof generated !== "string" || !generated.includes(`[mcp_servers.${AI_WORKBENCH_SERVER}]`)) {
    fail("CODEX_CONFIG_INVALID", "Generated Codex MCP configuration is invalid.");
  }
  let source = typeof existing === "string" ? existing : "";
  source = source.replace(
    new RegExp(`${CODEX_BEGIN.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[\\s\\S]*?${CODEX_END.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\n?`, "u"),
    "",
  );

  if (!source.trim()) return `${CODEX_BEGIN}\n${generated.trimEnd()}\n${CODEX_END}\n`;

  const { lines, headers } = tomlSectionNames(source);
  const remove = new Set();
  for (const header of headers) {
    let end = header.index + 1;
    while (end < lines.length && !/^\s*\[[^\]]+\]\s*(?:#.*)?$/u.test(lines[end])) end++;
    for (let index = header.index; index < end; index++) remove.add(index);
  }
  const preserved = lines.filter((_, index) => !remove.has(index)).join("\n").trimEnd();
  return `${preserved}${preserved ? "\n\n" : ""}${CODEX_BEGIN}\n${generated.trimEnd()}\n${CODEX_END}\n`;
}

async function writeCodexConfig({ config, projectDir, backupRoot }) {
  const file = path.join(projectDir, ".codex", "config.toml");
  const previous = await readOptional(file);
  const existing = previous ? new TextDecoder("utf-8", { fatal: true }).decode(previous) : "";
  const next = mergeCodexMcpConfig(existing, config.codexToml);
  if (previous && existing === next) {
    return { client: "codex", file, changed: false, backup: null };
  }
  const backup = previous ? await backupIfChanged(file, previous, backupRoot) : null;
  await atomicWrite(file, Buffer.from(next, "utf8"), 0o600);
  return { client: "codex", file, changed: true, backup };
}

async function writeQoderConfig({ config, projectDir, backupRoot }) {
  const file = path.join(projectDir, ".qoder", "settings.local.json");
  const previous = await readOptional(file);
  let current = {};
  if (previous) {
    try {
      current = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(previous));
    } catch {
      fail("QODER_CONFIG_INVALID", "Existing Qoder settings.local.json is not valid UTF-8 JSON.");
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      fail("QODER_CONFIG_INVALID", "Existing Qoder settings.local.json must contain a JSON object.");
    }
  }
  current.mcpServers = current.mcpServers && typeof current.mcpServers === "object" && !Array.isArray(current.mcpServers)
    ? current.mcpServers
    : {};
  current.mcpServers[AI_WORKBENCH_SERVER] = config.qoderConfig.mcpServers[AI_WORKBENCH_SERVER];
  const next = `${JSON.stringify(current, null, 2)}\n`;
  if (previous && previous.toString("utf8") === next) {
    return { client: "qoder", file, changed: false, backup: null };
  }
  const backup = previous ? await backupIfChanged(file, previous, backupRoot) : null;
  await atomicWrite(file, Buffer.from(next, "utf8"), 0o600);
  return { client: "qoder", file, changed: true, backup };
}

function workBuddySkill(config) {
  return `---
name: yaoayi-workbench
description: Route natural-language office, content, article, visual and video requests through the Yao Ayi System.
version: 1.0.0
author: Yao Ayi System contributors
allowed-tools: yaoayi_workbench_intent, pengmanager_agent_guide, pengmanager_video_workflow, pengmanager_video_preflight
---

# 姚阿姨系统任务入口

当用户要求写文章、做图文、做视频、剪辑、口播、继续已有的内容任务或核对交付时：

1. 先调用 \`yaoayi_workbench_intent\`，保留用户完整原话和已提供的约束。
2. 读取返回的 \`status\`、\`requiredInputs\`、\`stages\`、\`authorizationGates\` 与 \`handoff\`。计划不是完成，不能宣称已建单、已生成或已发布。
3. 视频任务先调用 \`pengmanager_video_preflight\`；正式生产由同一 checkout 的标准 CLI 执行。
4. 文章、视觉和混合素材任务需要管理员会话调用创作总控；受限 Agent 不能自行审批。
5. 每次外发都需要具体账号、完整获准正文/文件快照和本次授权，并在实际平台回读后记录回执。

当前 checkout：\`${config.rootDir}\`

私有视频目录：\`${config.dataDir}\`

完整接入矩阵与支持边界见 \`docs/AGENT-WORKBENCH-INTEGRATION.md\`。不要读取或输出令牌、Cookie、密码、模型密钥或私有授权正文。
`;
}

function workBuddyReadme() {
  return `# Yao Ayi System WorkBuddy Connector

This directory was generated by:

\`\`\`sh
node scripts/ai-workbench.mjs bootstrap --client workbuddy
\`\`\`

It follows the public WorkBuddy connector structure documented at:

- https://open.workbuddy.cn/docs/connector
- https://open.workbuddy.cn/docs/skill

The generated MCP uses the local checkout and Node executable recorded in \`mcp.json\`.
Keep that checkout at the same absolute path. No token or model secret is copied
into this package. WorkBuddy's own import, review, publish and OAuth/token UI are
platform gates and are not bypassed by this generator.
`;
}

function genericPrompt(config) {
  return `# Yao Ayi System Workbench Instructions

Use the existing checkout at \`${config.rootDir}\` and the same private video
directory at \`${config.dataDir}\`.

1. Read the complete \`AGENTS.md\`, \`docs/AI-AGENT-GUIDE.md\` and
   \`docs/AGENT-WORKBENCH-INTEGRATION.md\`.
2. Call MCP \`yaoayi_workbench_intent\` if MCP is available. Otherwise run
   \`node scripts/agent.mjs plan --input-file -\`.
3. Preserve the user's original intent. Follow the returned task graph, required
   inputs, administrator/owner gates and delivery evidence.
4. Video production uses \`scripts/video-standard.mjs\` in this checkout.
5. Content Director jobs require a real administrator session. Publication is a
   separate single-target authorization followed by actual platform readback.

Returning a route, plan, HTTP 200, draft, preview or running state is not a
completed business task.
`;
}

function qianwenPrompt(config) {
  return `# 千问办公接入说明

截至 2026-11-18，未检索到“千问办公”公开、可核实的本地 MCP/Connector 导入协议。
因此本文件只提供可复制的工作台提示词，不声称会自动写入未知客户端配置。

如果当前工作台具备本地文件/终端能力，请先克隆并保留以下 checkout：

\`${config.rootDir}\`

启动指令：

\`\`\`text
先完整读取 AGENTS.md、docs/AI-AGENT-GUIDE.md 和 docs/AGENT-WORKBENCH-INTEGRATION.md。
凡涉及文章、图文、视频、剪辑、口播或交付，先运行：
node scripts/agent.mjs plan --input-file -
把用户原话作为 {"intent":"原话"} 输入。
严格按返回的任务图执行；计划、HTTP 200、草稿和运行中都不是完成。
需要管理员建单、审批、付费、平台登录或外发时停在相应人工门，不得代批。
若工作台没有本地文件和终端能力，只能使用 GET /api/workbench/manifest 与
POST /api/workbench/plan 做只读规划，实际生产交给持有同一 checkout 的本机 Agent。
\`\`\`

如果后续千问办公公开官方 MCP/Connector 文档，再增加经过核实的原生适配器；
在此之前不要伪造客户端菜单路径、导入步骤或自动配置结果。
`;
}

async function writeFileRecord(root, relative, bytes) {
  const file = path.join(root, relative);
  await atomicWrite(file, Buffer.from(bytes), 0o600);
  return { path: relative, bytes: Buffer.byteLength(bytes), sha256: sha256(Buffer.from(bytes)) };
}

async function packageWorkBuddy({ config, outputRoot }) {
  const directory = path.join(outputRoot, "workbuddy");
  await mkdir(path.join(directory, "skills", "yaoayi-workbench"), { recursive: true, mode: 0o700 });
  const meta = {
    name: "Yao Ayi System",
    name_zh: "姚阿姨系统",
    name_en: "Yao Ayi System",
    description: "Plan and operate approved Yao Ayi content, visual and video work with real receipts.",
    description_zh: "把姚阿姨系统的内容、视觉、视频、审批和交付能力接入 WorkBuddy。",
    description_en: "Connect WorkBuddy to Yao Ayi System content, visual and video workflows with explicit approval and delivery evidence.",
    source: "yaoayi-system",
    type: "mcp",
    version: "1.0.0",
    minWorkbuddyVersion: "4.22.15",
    examples_zh: [
      "为姚阿姨写一篇关于沂蒙山秋日山货的文章并准备配图",
      "用姚阿姨系统规划一支 30 秒的咖啡小院短片",
      "继续上次的视频并核对真实交付回执",
    ],
    examples_en: [
      "Write an article about Yimeng Mountain seasonal produce for Yao Ayi and prepare visuals",
      "Plan a 30-second Yao Ayi coffee courtyard video",
      "Resume the previous video and verify the real delivery receipt",
    ],
  };
  const mcp = {
    mcpServers: {
      [AI_WORKBENCH_SERVER]: {
        type: "stdio",
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        env: config.env,
        timeout: 180000,
      },
    },
  };
  const records = [];
  records.push(await writeFileRecord(directory, "connector-meta.json", `${JSON.stringify(meta, null, 2)}\n`));
  records.push(await writeFileRecord(directory, "mcp.json", `${JSON.stringify(mcp, null, 2)}\n`));
  records.push(await writeFileRecord(directory, path.join("skills", "yaoayi-workbench", "SKILL.md"), workBuddySkill(config)));
  records.push(await writeFileRecord(directory, "README.md", workBuddyReadme()));
  const iconSource = path.join(config.rootDir, "public", "favicon.svg");
  const icon = await readFile(iconSource);
  records.push(await writeFileRecord(directory, "icon.svg", icon));
  const manifest = {
    schemaVersion: "yaoayi.workbuddy-connector/v1",
    generatedAt: new Date().toISOString(),
    productId: "yaoayi-system",
    rootDir: config.rootDir,
    dataDir: config.dataDir,
    files: records.sort((a, b) => a.path.localeCompare(b.path)),
    secretsCopied: false,
    providerCallsPerformed: false,
  };
  await writeFileRecord(directory, "package-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  const zipFile = path.join(outputRoot, "yaoayi-workbuddy-connector.zip");
  const temporaryZip = `${zipFile}.${randomUUID()}.tmp`;
  let zipCreated = false;
  try {
    await execFileAsync("zip", ["-qr", temporaryZip, "."], { cwd: directory, maxBuffer: 2 * 1024 * 1024 });
    await rename(temporaryZip, zipFile);
    await chmod(zipFile, 0o600);
    zipCreated = true;
  } catch {
    await unlink(temporaryZip).catch(() => undefined);
  }
  return { client: "workbuddy", directory, zipFile: zipCreated ? zipFile : null, zipCreated, files: records, secretsCopied: false };
}

async function packageGeneric({ config, outputRoot }) {
  const directory = path.join(outputRoot, "generic");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = [];
  files.push(await writeFileRecord(directory, "mcp.json", `${JSON.stringify(config.genericConfig, null, 2)}\n`));
  files.push(await writeFileRecord(directory, "AGENT-PROMPT.md", genericPrompt(config)));
  return { client: "generic", directory, files, secretsCopied: false };
}

async function packageQianwen({ config, outputRoot }) {
  const directory = path.join(outputRoot, "qianwen");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = [];
  files.push(await writeFileRecord(directory, "AGENT-PROMPT.md", qianwenPrompt(config)));
  files.push(await writeFileRecord(directory, "STATUS.md", "# Protocol status\n\nNo public native MCP/Connector import protocol was verified on 2026-11-18. This bundle is a generic shell/file fallback, not a claimed native integration.\n"));
  return { client: "qianwen", directory, files, nativeImportVerified: false, secretsCopied: false };
}

export function parseBootstrapClient(value = "all") {
  if (!CLIENTS.has(value)) fail("WORKBENCH_CLIENT_INVALID", "Use all, codex, qoder, workbuddy, generic or qianwen.");
  return value;
}

export async function bootstrapAiWorkbench({
  rootDir,
  dataDir,
  nodePath = process.execPath,
  modelEnvFile,
  client = "all",
  projectDir,
  outputRoot,
}) {
  const selected = parseBootstrapClient(client);
  const config = buildAiWorkbenchConfig({ rootDir, dataDir, nodePath, modelEnvFile });
  const project = projectDir ?? config.rootDir;
  const output = outputRoot ?? path.join(project, "var", "workbench");
  const backupRoot = path.join(output, "backups");
  const clients = selected === "all" ? ["codex", "qoder", "workbuddy", "generic", "qianwen"] : [selected];
  const results = [];
  for (const item of clients) {
    if (item === "codex") results.push(await writeCodexConfig({ config, projectDir: project, backupRoot }));
    else if (item === "qoder") results.push(await writeQoderConfig({ config, projectDir: project, backupRoot }));
    else if (item === "workbuddy") results.push(await packageWorkBuddy({ config, outputRoot: output }));
    else if (item === "generic") results.push(await packageGeneric({ config, outputRoot: output }));
    else if (item === "qianwen") results.push(await packageQianwen({ config, outputRoot: output }));
  }
  return {
    schemaVersion: "yaoayi.workbench-bootstrap/v1",
    productId: "yaoayi-system",
    rootDir: config.rootDir,
    dataDir: config.dataDir,
    outputRoot: output,
    results,
    networkCallsPerformed: false,
    providerCallsPerformed: false,
    configurationWritten: results.some((result) => result.changed || result.files),
    secretsCopied: false,
  };
}
