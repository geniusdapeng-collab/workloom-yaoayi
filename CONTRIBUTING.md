# Contributing

Thanks for helping improve Yao Ayi System.

## Before changing code

1. Read `AGENTS.md`, `docs/AI-AGENT-GUIDE.md` and the closest implementation
   guide.
2. Keep the same checkout and private data directory throughout a test.
3. Never commit credentials, cookies, model keys, private source material,
   customer data, raw platform receipts or generated runtime data under `var/`.
4. Preserve approval, budget, rights, publisher and receipt boundaries. A route
   plan, draft, preview or HTTP success is not a completed production or
   publication.

## Development

Use Node.js 24 or newer and the pnpm version declared by the relevant
`package.json`.

```bash
pnpm install --frozen-lockfile --ignore-scripts
node --check src/server.mjs
node --test tests/*.test.mjs
node --test engines/geo-evidence/test/*.test.mjs
pnpm test:vendor
node scripts/smoke.mjs
node scripts/security-scan.mjs
```

Changes to client bootstrap must also verify:

```bash
node scripts/ai-workbench.mjs bootstrap --client codex --output-dir /absolute/private/test-output
printf '%s\n' '{"intent":"写一篇关于沂蒙山秋日山货的文章"}' |
  node scripts/agent.mjs plan --input-file -
```

Use a temporary checkout or private output directory for generated client
configuration tests.

## Pull requests

Describe the user-visible behavior, actual commands/tests, remaining gaps and
rollback. Keep generated packages, secrets and machine-specific absolute paths
out of commits. By submitting a contribution, you agree that it is licensed
under the repository's Apache-2.0 license and that you have the right to submit
it.

## Assets and personas

The software license does not grant rights to the Yao Ayi / 姚阿姨 name,
likeness, voice, biography, brand, platform accounts, third-party media or
customer material. Do not add such assets unless their use and redistribution
rights are explicit and documented.
