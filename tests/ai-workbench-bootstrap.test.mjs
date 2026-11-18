import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bootstrapAiWorkbench,
  mergeCodexMcpConfig,
  parseBootstrapClient,
} from "../src/ai-workbench-bootstrap.mjs";
import { parseAiWorkbenchArgs } from "../scripts/ai-workbench.mjs";

const root = path.resolve(import.meta.dirname, "..");

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "yaoayi-bootstrap-space-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    projectDir: path.join(directory, "project"),
    outputRoot: path.join(directory, "generated state"),
    dataDir: path.join(directory, "private runtime"),
  };
}

test("Codex TOML merge replaces only the named MCP tables and preserves unrelated settings", () => {
  const generated = [
    "[mcp_servers.yaoayi-video]",
    'command = "/new/node"',
    'args = ["/new/agent-mcp.mjs"]',
    "",
    "[mcp_servers.yaoayi-video.env]",
    'PENGMANAGER_VIDEO_DATA_DIR = "/new/data"',
    "",
  ].join("\n");
  const existing = [
    'model = "do-not-touch"',
    "",
    "[mcp_servers.other]",
    'command = "/other"',
    "",
    "[mcp_servers.yaoayi-video]",
    'command = "/old/node"',
    "",
    "[mcp_servers.yaoayi-video.env]",
    'PENGMANAGER_VIDEO_DATA_DIR = "/old/data"',
    "",
    "[profiles.work]",
    'model = "same"',
    "",
  ].join("\n");
  const merged = mergeCodexMcpConfig(existing, generated);
  assert.match(merged, /model = "do-not-touch"/);
  assert.match(merged, /\[mcp_servers\.other\]/);
  assert.match(merged, /\[profiles\.work\]/);
  assert.match(merged, /command = "\/new\/node"/);
  assert.doesNotMatch(merged, /\/old\/node/);
  assert.equal(merged.match(/\[mcp_servers\.yaoayi-video\]/g).length, 1);
  assert.match(merged, /yaoayi-workbench generated section/);
});

test("bootstrap writes project-local Codex and Qoder config without secrets or touching the checkout", async (t) => {
  const { directory, projectDir, outputRoot, dataDir } = await fixture(t);
  await mkdir(path.join(projectDir, ".qoder"), { recursive: true });
  await writeFile(path.join(projectDir, ".qoder", "settings.local.json"), JSON.stringify({
    theme: "keep",
    mcpServers: { other: { command: "/other" } },
  }));
  const previousGithub = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "synthetic-github-secret-not-for-output";
  t.after(() => {
    if (previousGithub === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGithub;
  });

  const result = await bootstrapAiWorkbench({
    rootDir: root,
    dataDir,
    client: "all",
    projectDir,
    outputRoot,
  });
  assert.equal(result.schemaVersion, "yaoayi.workbench-bootstrap/v1");
  assert.equal(result.networkCallsPerformed, false);
  assert.equal(result.providerCallsPerformed, false);
  assert.equal(result.secretsCopied, false);
  const codex = await readFile(path.join(projectDir, ".codex", "config.toml"), "utf8");
  assert.match(codex, /mcp_servers\.yaoayi-video/);
  assert.match(codex, /scripts\/agent-mcp\.mjs/);
  const qoder = JSON.parse(await readFile(path.join(projectDir, ".qoder", "settings.local.json"), "utf8"));
  assert.equal(qoder.theme, "keep");
  assert.equal(qoder.mcpServers.other.command, "/other");
  assert.equal(qoder.mcpServers["yaoayi-video"].type, "stdio");
  assert.ok(result.results.find((row) => row.client === "workbuddy").zipCreated);
  const workbuddyMcp = JSON.parse(await readFile(path.join(outputRoot, "workbuddy", "mcp.json"), "utf8"));
  assert.equal(workbuddyMcp.mcpServers["yaoayi-video"].cwd, root);
  assert.equal(workbuddyMcp.mcpServers["yaoayi-video"].type, "stdio");
  const skill = await readFile(path.join(outputRoot, "workbuddy", "skills", "yaoayi-workbench", "SKILL.md"), "utf8");
  assert.match(skill, /yaoayi_workbench_intent/);
  assert.ok((await readFile(path.join(outputRoot, "generic", "AGENT-PROMPT.md"), "utf8")).includes("scripts/agent.mjs plan"));
  assert.ok((await readFile(path.join(outputRoot, "qianwen", "STATUS.md"), "utf8")).includes("No public native MCP"));
  for (const file of [
    path.join(projectDir, ".codex", "config.toml"),
    path.join(projectDir, ".qoder", "settings.local.json"),
    path.join(outputRoot, "workbuddy", "connector-meta.json"),
    path.join(outputRoot, "workbuddy", "mcp.json"),
    path.join(outputRoot, "generic", "mcp.json"),
  ]) {
    const text = await readFile(file, "utf8");
    assert.equal(text.includes("synthetic-github-secret-not-for-output"), false);
  }
  await access(path.join(directory, "generated state", "yaoayi-workbuddy-connector.zip"));
});

test("bootstrap is idempotent and backs up a changed existing Codex file", async (t) => {
  const { projectDir, outputRoot, dataDir } = await fixture(t);
  await mkdir(path.join(projectDir, ".codex"), { recursive: true });
  await writeFile(path.join(projectDir, ".codex", "config.toml"), 'model = "keep"\n\n[mcp_servers.yaoayi-video]\ncommand = "/old"\n');
  const first = await bootstrapAiWorkbench({ rootDir: root, dataDir, client: "codex", projectDir, outputRoot });
  assert.equal(first.results[0].changed, true);
  assert.ok(first.results[0].backup);
  assert.equal(await readFile(first.results[0].backup, "utf8"), 'model = "keep"\n\n[mcp_servers.yaoayi-video]\ncommand = "/old"\n');
  const second = await bootstrapAiWorkbench({ rootDir: root, dataDir, client: "codex", projectDir, outputRoot });
  assert.equal(second.results[0].changed, false);
  assert.equal(second.results[0].backup, null);
});

test("bootstrap rejects symlinked client configuration and validates CLI options", async (t) => {
  const { directory, projectDir, outputRoot, dataDir } = await fixture(t);
  await mkdir(path.join(projectDir, ".codex"), { recursive: true });
  const outside = path.join(directory, "outside.toml");
  await writeFile(outside, 'model = "outside"\n');
  await symlink(outside, path.join(projectDir, ".codex", "config.toml"));
  await assert.rejects(
    bootstrapAiWorkbench({ rootDir: root, dataDir, client: "codex", projectDir, outputRoot }),
    { code: "WORKBENCH_TARGET_INVALID" },
  );
  assert.equal(parseBootstrapClient("workbuddy"), "workbuddy");
  assert.throws(() => parseBootstrapClient("unknown"), { code: "WORKBENCH_CLIENT_INVALID" });
  assert.equal(parseAiWorkbenchArgs(["bootstrap", "--client", "all"]).command, "bootstrap");
  assert.throws(() => parseAiWorkbenchArgs(["bootstrap", "--client", "workbuddy", "--unknown", "x"]), { code: "USAGE" });
  assert.throws(() => parseAiWorkbenchArgs(["config", "--client", "workbuddy"]), { code: "USAGE" });
});
