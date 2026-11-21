# Changelog

## 0.6.4 — 2026-11-21

- Suggest section counts from the target length of new Chinese courtyard articles. Use brief headings drawn from the corresponding passage and place section breaks where the subject changes.
- Carry the heading guidance through drafting, scoped repair and both editorial reviews. Preserve frozen courtyard policies from previous versions.

## 0.6.3 — 2026-11-21

- Refine the Chinese courtyard prose policy with openings grounded in a particular observation, varied pacing, and concrete endings. Drafting, repair, and both reviews use the same versioned guidance.
- Keep the existing length checks and the policies already recorded on earlier jobs. The handcraft and explainer policies retain their previous versions.

## 0.6.2 — 2026-11-21

- Freeze a versioned prose policy on new Chinese article jobs and reuse it throughout drafting, repair, AI review and final acceptance.
- Show the proposed article policy in the read-only workbench plan. Preserve earlier jobs, photo receipts and the canonical persona contract.
- Align the deployment package manifest with the Yao Ayi installer and test the two tools together.

## 0.6.1 — 2026-11-21

- Require at least three distinct reviewed inline article photographs or illustrations before final acceptance and publication.
- Find openly licensed real photography on Wikimedia Commons, preserve exact provenance and visible attribution, and support the native visual designer and Compositor workflow with verified local outputs.
- Run AI preliminary reviews against exact source, content and preparation snapshots. Keep one human final acceptance for each complete native delivery and retain distinct external action authorization.
- Preserve historical content and report bytes when rebinding a draft or reading an already published snapshot.

## 2026-11-19 — Cross-client persona enforcement and QoderWork

- Make Yao Ayi persona v1.0.1 a server-enforced content contract shared by
  Codex, Qoder, QoderWork, WorkBuddy, generic MCP/CLI and 千问办公 fallback.
- Inject the same persona prompt into outline, section drafting, repair,
  independent audit, final audit and visual planning.
- Freeze persona ID, version, canonical-document SHA-256 and prompt SHA-256 into
  Content Director Jobs, result hashes and delivery results.
- Add deterministic persona checks for forbidden host voice, unsupported
  absolute product claims, false rural narratives and missing first person.
- Include the complete canonical persona reference in WorkBuddy, QoderWork,
  generic and 千问办公 generated bundles; add the persona to MCP agent guides.
- Add QoderWork JSON/STDIO MCP, skill and prompt generation based on its public
  connector documentation, with the published 2027-09-05 discontinuation date.

## 2026-11-18 — Open-source and cross-workbench delivery

- License the original repository source under Apache-2.0 and document that the
  software license does not grant persona, likeness, voice, brand, customer,
  third-party media or external-platform rights.
- Add the read-only `yaoayi_workbench_intent` MCP tool, CLI `plan` command,
  `GET /api/workbench/manifest` and `POST /api/workbench/plan`. They reuse the
  existing deterministic Content Director route and return a task DAG,
  required inputs, approval gates, handoff and delivery evidence.
- Add safe project bootstrap for Codex and Qoder plus generated WorkBuddy MCP +
  Skill Connector, generic MCP/prompt and 千问办公 fallback bundles. Generated
  machine-specific configuration stays Git-ignored and never copies secrets.
- Distinguish routing, job creation, production, independent review, human
  approval, materialization, publication and platform readback as separate
  states. A plan or HTTP success is not a completion receipt.

## 2026-11-17 — Content Director unified content system

- Add one admin entry for seven content routes: article, article-plus-visual,
  pure visual, AI video, real-footage edit, talking-head edit and mixed video.
- Add a persistent ContentJob/Batch state machine with exact ETags, idempotency,
  two-Job scheduling, pause/resume/cancel, per-step checkpoints and failure
  isolation.
- Add real private source uploads with server-recomputed hashes, format
  validation, path confinement and Job-bound attachment receipts.
- Add long-form Brief, research, outline freeze, section research and drafting,
  deterministic completeness/fact/style gates, bounded section repair and a
  separately recorded final audit.
- Add editable visual packages with JSON, Mermaid source, SVG and decoded PNG,
  visual order/rerender revisions, rights/privacy review and immutable Edition
  materialization.
- Add native video handoff for the existing Studio/edit/talking-head engines,
  including per-shot mixed-source manifests and explicit non-production status
  when runtime, model or budget authorization is missing.
- Add downstream Content Ops planning and distinct Edition/public-site/external
  publication statuses without granting publication authority.
- Add schema 3→4 additive migration, one-key entry rollback, administrative
  documentation and operator metrics/error views.
- Verify 140 routing cases, 30 offline article themes, 562 root tests, 14 GEO
  engine tests, 76 Node video tests, 74 Vitest video tests and real Chrome
  desktop/mobile layouts with no horizontal overflow or console errors.

## 2026-11-05 — Codex and Qoder conversation workflow

- Add read-only, absolute-path MCP configuration export for Codex, Qoder and
  other local stdio clients without copying secrets or overwriting host settings.
- Add `pengmanager_agent_guide` and the CLI `guide` command to return the complete
  current checkout instructions, byte hashes and actual CLI/MCP support boundary.
- Add Qoder project Agent guidance and a shared setup guide. Full production
  continues through the existing owner CLI with original budgets and receipts;
  pure MCP clients without shell do not gain a new production executor.
- Keep client and owner runtimes on the same private directory, document safe
  handover and timeout recovery, and verify real CLI/MCP entry processes.
- Recognize an exact structured native artifact ID in receipt sensitivity
  checks, while retaining prose, credential and malformed-ID protection.

## 2026-10-25 — Bilingual editorial publishing and real media

- Add crawlable Chinese/English article, visual and video pages with full text,
  independent language revisions, real player/attachments and private previews.
- Add versioned Stories/Editions/destination-specific variants, explicit account
  and destination lifecycle, platform catalog and migration baselines while
  preserving original content, receipts and event hashes.
- Add exact snapshot approvals, optimistic concurrency and idempotent retries;
  owned-site activation requires an actual complete state/media backup and
  publication requires fixed-origin document/hydration/media-byte readback.
- Add actual bounded binary uploads, rights/privacy review, authenticated and
  current-release media access, Range/HEAD, revocation and isolated restore.
- Add administrator recovery of existing operation results against original
  snapshots without replaying outbound publishing or overwriting changed text.
- Add exclusive JSON writer ownership, bounded HTTP shutdown, read-only migration
  planning and complete editorial backup/verification/isolated-restore tooling.
- Preserve scoped Agent boundaries, local video generation and Mac final-content
  backup; catalog presence does not represent a connected platform account.

## 2026-10-24 — PengManager identity update

### Changed

- Rename the product to 鹏经理系统 / PengManager System while retaining the
  existing `geniusdapeng-collab/geniusdapeng-geo-os` repository URL.
- Standardize the main account as 李大鹏 / PengManager, with the Chinese display
  name 李大鹏｜用AI搞经营的产品经理 and English display name Dapeng Li · PengManager.
- Apply the supplied Chinese and English bios to the canonical identity,
  platform profiles, dashboard and relevant content-production defaults.
- Refresh personal GEO query and article defaults for the current identity,
  while retaining recognition aliases and stable case/query IDs.
- Migrate recognized legacy runtime defaults once and append an identity event;
  retain customized queries, approved facts, publication receipts and previous
  event hashes.
- Rewrite the README and current architecture, API, operations and seed guidance
  to describe the product, migration and local/private operating boundaries.

Historical live verification receipts below remain records of their original
dates; this identity update does not imply a new all-platform publication.

## 0.4.1 - 2026-10-19

### Fixed

- Revalidate approved Claim state, expiry, target platform and account policy
  before every external publication.
- Serialize live publication per content item so concurrent requests cannot
  create duplicate GitHub Issues.
- Reject cross-origin browser writes and non-allowlisted Host headers, and add
  a restrictive Content-Security-Policy to the local control plane.
- Keep fixture data out of aggregate GEO metrics and record the exact prompt
  sent to the model.
- Reject unsafe citation schemes, loopback/private citation targets, unsafe
  redirect chains and oversized fetched response bodies.
- Pass the requested cover title and hook through to real media delivery, and
  report the installed `tsx` runtime truthfully.
- Make the default video-edit live check use the vendored engine and record the
  pinned upstream commit.
- Return truthful draft, queued, local and connector-required receipts instead
  of labelling non-real operations as `real`.
- Restore the integrated video-engine TypeScript and rhythm-audio test paths.

### Verified

- 38 root tests, 11 GEO engine tests, 74 Node video-engine tests and 74
  Vitest video-engine tests
- 12/12 real DeepSeek Search queries
- Real model-to-content-to-FFmpeg delivery with two 640x360 MP4 variants
- Google Chrome desktop/mobile interaction and responsive-layout checks
- Model-driven GitHub Issue publication with official API readback

## 0.4.0 - 2026-10-18

### Integrated

- Vendored and personalized GeoEvidence SQLite, collection, metrics,
  incidents, article and publication engine
- Vendored WorkLoom-video-edit post-production, subtitles, color, BGM,
  transitions, cover, delivery package and feedback-triage engine
- Unified server, JSON event ledger and media-job history
- Unified dashboard tabs for GEO engine metrics and media production

### Verified

- 12/12 real personal DeepSeek queries
- 10 personal article drafts
- Two real 640x360 six-second video variants with covers, subtitles and
  technical quality receipts
- Model-driven GitHub Issue publication

## 0.3.0-alpha.1 - 2026-10-18

### Added

- DeepSeek model adapter using the local Responses-compatible gateway
- DeepSeek Search + Chat/Responses real collection with hash evidence
- GeoEvidence Studio production HTTP adapter
- WorkLoom-video-edit cover knowledge-base production CLI adapter
- GitHub official REST API publication adapter
- Model-generated content pipeline with claim, approval and schedule gates
- Live adapter health panel
- Sanitized live receipts under `docs/evidence/`

### Verified

- 12/12 DeepSeek queries completed
- GeoEvidence live run completed with `receipt.synced=true`
- video-edit cover bridge health and enrichment passed
- GitHub issue #1 created and read back through the official API

## 0.1.0 - 2026-10-18

- Initial private GEO control plane
- 16 platform profiles
- Claim, content, publication, interaction and GEO observation models
- Hash-chained append-only local ledger
- 120-topic content bank
