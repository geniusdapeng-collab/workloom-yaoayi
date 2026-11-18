# 姚阿姨系统 · Yao Ayi System — Architecture

## Decision

姚阿姨系统 (Yao Ayi System) is an independent private, local-first system for 姚阿姨 / Yao Ayi. It keeps the person, place, product-claim, content-graph, approval and receipt ledger in one control plane, and runs a vendored personal GEO engine plus a vendored media-production engine inside the same private repository.

The Chinese display name is `姚阿姨｜沂蒙山咖啡小院主理人`; the English display name is `Yao Ayi · Yimeng Mountain Coffee Courtyard`. The canonical profile also supplies account bios, content ownership defaults and public-preview identity fields. The long-form persona and truth boundaries live in `docs/personas/yao-ayi-yimeng-coffee-courtyard.md`.

The complete pinned Edit source is contained under `engines/video-edit`, including the native server, web workbench, PostgreSQL schema, model routing, production SDK, digital employees, skills, tools, research and media libraries. Yao Ayi supervises its own separate video database and native services; it does not delegate production to a separately running Edit installation. A private repository still does not serve as the public GEO evidence layer.

## Runtime

```text
Local dashboard
      |
      v
HTTP API -> domain policy -> append-only event ledger -> local JSON state
      |                           |
      |                           +-> claims / content / receipts / observations
      |
      +-> DeepSeek Responses/Chat/Search API
      +-> PersonalGeoEngine (in-process GeoEvidence SQLite/collection/metrics/articles)
      +-> VideoMediaEngine (in-process FFmpeg/post/subtitle/color/BGM/cover/package)
      +-> GitHub official REST API
      +-> fail-closed manual adapters for other platforms
      |
      +-> owned video supervisor
            +-> private PostgreSQL + native migrations/assembly
            +-> embedded native video backend + real local owner session
            +-> owned loopback-root workbench + authenticated native API proxy
            +-> local tool stations and explicitly configured providers
```

The control-plane records use local JSON with a hash event chain. Rich GEO runs use the vendored SQLite engine. Media jobs store a separate local delivery directory and receipt with output hashes for each job. The documented runtime uses Node.js 24, SQLite built-ins, FFmpeg/FFprobe and the pinned `tsx` toolchain.

The JSON ledger and GEO SQLite remain authoritative for existing personal operations. Native video transactions, budget reservations, approvals and archive recovery remain in the independent video PostgreSQL database. No flattening or destructive data conversion joins these stores. A single root start command starts the dashboard, then launches its own video supervisor; video failure is isolated from the existing control plane. Stop cancels pending video setup/start, waits for owned-service cleanup and active HTTP completion, then closes GEO.

Video credentials and database data live in an owner-only directory outside the repository. PostgreSQL tool installation copies an explicit tool prefix; it never copies another application's database. The runtime checks embedded module realpaths, lock/pin, owned process/port and database identity before use. Only controlled local services are proxied; no arbitrary upstream URL is accepted.

The complete workbench uses an owned loopback root origin rather than a subpath iframe. This preserves its original routing and authentication and keeps the root dashboard CSP and framing restrictions intact. A process-only bootstrap key obtains a genuine native owner session from the scoped local backend. Root `/api/video-runtime/*` routes expose only safe read-only projections; they neither return sessions nor derive native identity from body `actor`/`approvedBy`. Native protected procedures retain active-member, workspace and tenant checks.

`pengmanager-capabilities.json` is generated from the embedded declarations. The root directory includes every role, skill, tool, capability and installer with search and pagination. Declared code, dependency diagnosis and validated production are separate fields. Actual station installed/ready/running results are displayed separately from that source inventory. Neither a catalog row nor a health response proves paid generation, media quality or external publication.

## Trust chain

1. A claim records its source, evidence level, sensitivity, public level and expiry.
2. Non-opinion content must reference at least one claim.
3. Approval checks claim state, expiry and sensitive text.
4. A scheduled content item can only become published through receipt recording, either from the manual endpoint or after the GitHub adapter returns its external receipt.
5. The receipt must contain a public URL, capture time, publisher and a `real` or `imported` data mode.
6. Each state mutation appends a SHA-256 hash event linked to the previous event.

The event chain is tamper-evident. It is not a trusted timestamp, platform signature or replacement for a real external receipt.

## Boundaries

- The server binds to `127.0.0.1` by default.
- Runtime state is local and ignored by Git.
- Public export only reads `approved_public` claims.
- All platform accounts start with `manual_review_required`.
- GitHub issue publication is live and receipt-verified. Other platform writes remain disabled until their official credentials and policies are reviewed.
- The repository contains no credentials.

## Integrated engines and external adapters

- `DeepSeekAdapter` uses the unified `text.primary` Chat dispatcher and the process-scoped credential resolver. The canonical model is `deepseek-flash`; every call records the scene policy, full-window token plan, usage, model identity, finish reason and request/response hashes. Search remains the provider's separate tools endpoint.
- `PersonalGeoEngine` runs the adapted GeoEvidence SQLite store, providers, analysis, incidents, article generation and publication receipts in-process. Its default case is `yaoayi-yimeng-coffee-courtyard`; `ps-*` query IDs link observations to entity, story, local-produce and risk questions.
- `VideoMediaEngine` retains the existing local quick-post workflow: it clips inputs to at most four seconds each, creates synthetic ambient audio and runs FFmpeg post-production, cover and packaging. Its UI states these limits. The complete native workbench owns AI generation, editing and presenter workflows.
- `VideoEditAdapter` exposes cover knowledge hints and feedback triage from the same vendored engine.
- `GitHubAdapter` creates a real owner/repo Issue through the official REST API and records the issue URL and content hash.

No adapter may convert fixture or mock output into a real publication receipt.

## Identity migration

New state uses the current Yao Ayi profile. After opening an older store, the server runs the profile migration before constructing services and engines. The migration updates the system/profile fields, resets built-in account templates to “待核对”, replaces default tests and unapproved facts, preserves approved history and appends an `identity.updated` event. Repeated starts do not append the same migration again.

Custom IDs and non-default content remain separate from the built-in Yao Ayi seed. Approved claims, published content, publication receipts and event history remain append-only. The private repository is not a public GEO source, and startup never updates an external platform profile or publication.

## Domain objects

- `EntityProfile`: one person, bilingual account/display names and bios, plus stable recognition aliases
- `Account`: platform profile and publication boundary
- `Claim`: a sourced, versioned fact or expertise statement
- `Query`: a stable GEO question and target surface
- `Content`: a draft or approved content atom
- `Publication`: an external receipt bound to content and account
- `Interaction`: a classified comment, message or recruiting lead
- `Observation`: one AI answer sample with citations and derived metrics
- `Event`: append-only mutation evidence

See [API.md](API.md) for endpoints, [adr/ADR-001-control-plane.md](adr/ADR-001-control-plane.md) and [adr/ADR-002-integrated-monorepo.md](adr/ADR-002-integrated-monorepo.md) for historical context, and [adr/ADR-003-complete-video-runtime.md](adr/ADR-003-complete-video-runtime.md) for the complete independent video architecture.
