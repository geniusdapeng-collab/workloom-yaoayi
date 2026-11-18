#!/usr/bin/env node
import path from 'node:path';
import { buildAiWorkbenchConfig } from '../src/ai-workbench-config.mjs';
import { bootstrapAiWorkbench, parseBootstrapClient } from '../src/ai-workbench-bootstrap.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const USAGE = 'node scripts/ai-workbench.mjs config|bootstrap [--client all|codex|qoder|workbuddy|generic|qianwen] [--data-dir ABSOLUTE_PRIVATE_DIR] [--model-env-file ABSOLUTE_PRIVATE_ENV_FILE] [--output-dir ABSOLUTE_OUTPUT_DIR]';
function usage() { const error = new Error(USAGE); error.code = 'USAGE'; throw error; }
export function parseAiWorkbenchArgs(args) {
  const [command, ...rest] = args;
  if (!['config', 'bootstrap'].includes(command)) usage();
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index], value = rest[index + 1];
    const allowed = command === 'config'
      ? ['--client', '--data-dir', '--model-env-file']
      : ['--client', '--data-dir', '--model-env-file', '--output-dir'];
    if (!allowed.includes(key) || !value || value.startsWith('--') || Object.hasOwn(options, key)) usage();
    options[key] = value;
  }
  const client = options['--client'] ?? 'all';
  try { parseBootstrapClient(client); } catch { usage(); }
  if (command === 'config' && !['all', 'codex', 'qoder', 'generic'].includes(client)) usage();
  const outputDir = options['--output-dir'];
  if (outputDir !== undefined && (!path.isAbsolute(outputDir) || path.resolve(outputDir) !== outputDir)) usage();
  return { command, client, dataDir: options['--data-dir'], modelEnvFile: options['--model-env-file'], outputDir };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(USAGE + '\n'); return; }
  try {
    const { command, client, outputDir, ...options } = parseAiWorkbenchArgs(args);
    if (command === 'bootstrap') {
      const result = await bootstrapAiWorkbench({ rootDir: ROOT, client, outputRoot: outputDir, ...options });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }
    const config = buildAiWorkbenchConfig({ rootDir: ROOT, ...options });
    const output = client === 'codex' ? config.codexToml : JSON.stringify(client === 'qoder' ? config.qoderConfig : client === 'generic' ? config.genericConfig : config, null, 2);
    process.stdout.write(output + (output.endsWith('\n') ? '' : '\n'));
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code) ? error.code : 'AI_WORKBENCH_CONFIG_FAILED';
    const message = code === 'AI_WORKBENCH_CONFIG_FAILED' ? 'AI workbench operation could not be completed.' : error.message;
    process.stderr.write(JSON.stringify({ error: { code, message } }) + '\n');
    process.exitCode = 1;
  }
}
if (path.resolve(process.argv[1] ?? '') === path.resolve(import.meta.filename)) await main();
