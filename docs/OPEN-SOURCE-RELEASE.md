# Open-source Release Audit

Audit date: 2026-11-18

This record covers the repository's transition to an Apache-2.0 source
distribution. It is an engineering release check, not a legal opinion.

## License boundary

- Original repository source is licensed under Apache-2.0 in `LICENSE` and
  `package.json`.
- `NOTICE` retains upstream attribution and states that the software license
  does not grant rights to the Yao Ayi / 姚阿姨 name, likeness, voice, biography,
  brand, platform accounts, customer data, third-party media or external
  services.
- The integrated GEO and video engines retain their own Apache-2.0 `LICENSE`
  and `NOTICE` files.
- Tracked vendored components retain their own license files, including MIT for
  Compositor Kit, DSH and SRT Whiteboard, and Apache-2.0 for the adapted
  Hyperreality system.
- `node_modules/` is not tracked. `git ls-files node_modules
  engines/video-edit/node_modules` returns zero files in the audited checkout.
- Runtime gates still apply to fonts, voices, likeness, stock media, BGM,
  commercial video components, model providers and external platforms.

## Secret and private-data checks

- Current tracked tree: `node scripts/security-scan.mjs` scanned 4,345 files and
  reported zero matches for GitHub PATs, private-key headers, AWS access keys
  and OpenAI-style keys.
- Full reachable Git history: patches from every reachable commit were scanned
  for the same signatures plus generic bearer headers. The audit reported zero
  findings.
- Generated `.codex/config.toml`, `.qoder/settings.local.json`,
  `var/workbench/` Connector packages and backups are Git-ignored. Tests verify
  that synthetic GitHub/model values do not enter generated configuration.
- Test fixture email addresses and credentials are synthetic placeholders.
  The vendored public SuperMickey author README contains its already-public
  author contact and Apache-2.0 license; it remains attributed as upstream
  material rather than being repurposed as a runtime credential.

## Functional verification

| Check | Result |
| --- | --- |
| Root Node tests | 577 passed |
| GEO engine tests | 11 passed |
| Video post-bridge Node tests | 76 passed |
| Video post-bridge Vitest tests | 74 passed |
| Smoke | health, dashboard, GEO and media routes 200 |
| Codex/Qoder bootstrap | idempotent merge, private backup and no secret copy verified |
| WorkBuddy package | MCP + Skill directory and zip generated; official platform review remains external |
| Full Git-history secret scan | 0 findings |

## Evidence grades

- **A:** Direct read of the root and integrated-engine license/notice files,
  workbench modules, HTTP routing, MCP/CLI entrypoints and generated Connector
  package behavior.
- **B:** Whole-tracked-tree and whole-reachable-history script scans, the test
  suites above, lockfile install and package-license assertions.
- **C:** Spot checks of third-party asset documentation and vendor license
  sidecars beyond the components directly changed by this release.
- **D:** Legal compatibility conclusions for every third-party asset. A
  downstream distributor remains responsible for its own legal and rights
  review before commercial use.

## Remaining release gates

- GitHub repository visibility and owner-controlled branch protection.
- A CI run on the exact candidate commit and a readback after merge to `main`.
- WorkBuddy developer-account import, review, publication and user installation.
- Any provider, model, platform or persona use that requires a separate
  business or rights authorization.
