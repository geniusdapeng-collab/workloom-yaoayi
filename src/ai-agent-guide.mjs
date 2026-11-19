import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { modelEnvironmentArgs } from './ai-workbench-paths.mjs';
import { YAO_AYI_PERSONA_CONTRACT } from './domain/persona.mjs';

export const AGENT_GUIDE_ID = 'pengmanager.agent.guide';
export const MCP_INSTRUCTIONS = '先调用 pengmanager_agent_guide 并完整读取返回的文档，再执行姚阿姨系统任务。所有内容、视觉、视频文案与审核必须遵守姚阿姨人设 v1.0.1；先核对 persona.documentSha256 与 promptSha256，禁止因 Codex、Qoder、QoderWork、WorkBuddy、千问办公或通用客户端不同而改写身份事实、声线、价值观和事实红线。用户只需对话：请求先调用 yaoayi_workbench_intent 复用现有意图路由与任务拆解；有 shell 的工作台执行同一 checkout 与私有目录的标准 CLI，纯 MCP 不提供完整生产执行器。视频制作沿用 pengmanager_video_workflow、pengmanager_video_preflight 和原生授权/预算/回执。计划不是成片，路由不是 Job，HTTP 200 不是发布；未知结果先对账，不重派。';

export const agentGuideDescriptor = {
  id: AGENT_GUIDE_ID, title: '读取姚阿姨系统 AI Agent 完整接入指南',
  description: '首次接入、更新源码或开始任务时先调用。返回本 checkout 的完整指南、姚阿姨人设合同、SHA-256、绝对 CLI 入口和 CLI/MCP 支持边界；只读，不读取密钥或私有授权，不启动服务。',
  operation: 'read', risk: 'low', dataMode: 'unverified',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const documents = [
  'AGENTS.md',
  'docs/AI-AGENT-GUIDE.md',
  'docs/AI-WORKBENCH-SETUP.md',
  'docs/AGENT-WORKBENCH-INTEGRATION.md',
  'docs/personas/yao-ayi-yimeng-coffee-courtyard.md',
  'docs/CODEX-VIDEO-QUICKSTART.md',
  '.agents/skills/yaoayi-workbench/SKILL.md',
  '.agents/skills/pengmanager-standard-video/SKILL.md',
];

/** Read only the fixed, current checkout instructions, never a caller path. */
export function readAiAgentGuide({ rootDir, dataDir, nodePath = process.execPath, execArgv = process.execArgv,
  runtimeEnvironment = { PENGMANAGER_VIDEO_DATA_DIR: dataDir } }) {
  const root = fs.realpathSync(rootDir);
  const nodeArgs = modelEnvironmentArgs(root, execArgv);
  const docs = documents.map(relativePath => {
    const file = path.join(root, relativePath);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1024 * 1024 || fs.realpathSync(file) !== file) throw new Error('Invalid guide.');
      const bytes = fs.readFileSync(file);
      if (bytes.length > 1024 * 1024) throw new Error('Oversized guide.');
      const markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { path: relativePath, absolutePath: file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, markdown };
    } catch {
      const error = new Error('A required checkout guide is missing, redirected, invalid or unreadable: ' + relativePath);
      error.code = 'AGENT_GUIDE_UNAVAILABLE';
      throw error;
    }
  });
  const personaDocument = docs.find(document => document.path === YAO_AYI_PERSONA_CONTRACT.canonicalDocument);
  if (!personaDocument || personaDocument.sha256 !== YAO_AYI_PERSONA_CONTRACT.documentSha256) {
    const error = new Error('The canonical Yao Ayi persona document is missing or does not match the enforced persona contract.');
    error.code = 'PERSONA_CONTRACT_UNAVAILABLE';
    throw error;
  }
  return {
    schemaVersion: 'pengmanager.ai-agent-guide/v1', productId: 'yaoayi-system',
    rootDir: root, dataDir, documents: docs,
    persona: { ...YAO_AYI_PERSONA_CONTRACT, document: {
      path: personaDocument.path,
      absolutePath: personaDocument.absolutePath,
      sha256: personaDocument.sha256,
      bytes: personaDocument.bytes,
    } },
    support: { shellRequiredForProduction: true, pureMcpProductionSupported: false,
      mcp: ['guide', 'catalog', 'registered-capabilities', 'workflow-plan', 'preflight'],
      standardCli: ['plan', 'start', 'status', 'resume', 'deliver'] },
    cli: {
      agent: { command: nodePath, argsPrefix: [...nodeArgs, path.join(root, 'scripts/agent.mjs')], env: runtimeEnvironment, dataArgs: ['--data-dir', dataDir] },
      standardVideo: { command: nodePath, argsPrefix: [...nodeArgs, path.join(root, 'scripts/video-standard.mjs')], env: runtimeEnvironment, dataArgs: ['--data-dir', dataDir],
        inputModes: ['plan', 'start', 'resume', 'deliver'], inputArgs: ['--input-file', '-'], statusJobOption: '--job' },
      config: { command: nodePath, env: runtimeEnvironment,
        args: nodeArgs.length > 1 ? null : [path.join(root, 'scripts/ai-workbench.mjs'), 'config', '--data-dir', dataDir,
          ...(nodeArgs.length ? ['--model-env-file', nodeArgs[0].slice('--env-file='.length)] : [])],
        ...(nodeArgs.length > 1 ? { code: 'MULTIPLE_MODEL_ENV_FILES_REQUIRE_EXPLICIT_CONFIG' } : {}) },
    },
    modelEnvironment: { source: nodeArgs.length ? 'explicit-node-env-file-paths' : 'current-process-only',
      nodeArgs, inheritedByHostShell: false,
      requirement: 'Execute the returned Node arguments in order. Without an explicit env-file, provide the current authorized model configuration in the owner CLI process; MCP environment variables do not propagate back to the host shell.' },
    lifecycle: 'Before owner CLI execution, verify no local work is active, stop only this MCP session\'s managed runtime with pengmanager_video_stop and read back its stopped status. Read an active job through its original run first. One supervisor owns a private directory. Never stop another process or remove its lock.',
    authorization: 'Guide availability is not authorization. Preserve existing owner policy, native permissions, budgets, rights, approvals and original receipts. Never fabricate approval evidence or extend the user\'s actual authorization.',
    providerCallsPerformed: false, productionVerified: false,
  };
}
