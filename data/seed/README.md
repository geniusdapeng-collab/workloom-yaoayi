# 姚阿姨系统 · Yao Ayi System — Seed data

The seed data is private working material.

The current main account is 姚阿姨 / Yao Ayi. Its Chinese display name is
`姚阿姨｜沂蒙山咖啡小院主理人` and its English display name is
`Yao Ayi · Yimeng Mountain Coffee Courtyard`. The canonical profile supplies
the same identity and bios to new state and platform account records; see the
[README](../../README.md) for the exact account copy and the
[persona document](../../docs/personas/yao-ayi-yimeng-coffee-courtyard.md) for content
boundaries.

- `accounts.json`: 16 platform profiles, all starting with manual policy review.
- `claims.json`: owner-provided persona facts and publication boundaries.
- `queries.json`: 12 DeepSeek-first entity, story and local-produce questions.
- `content.json`: four first-person image-text drafts for review.
- `content-bank.json`: 120 initial Yimeng Mountain story and product topics.

Seed records are not proof of publication or business results. Content topics marked `待立项` still require fact, privacy, copyright and identity review.

Updating seed files alone does not overwrite existing runtime state. The server
runs the versioned Yao Ayi identity migration when opening legacy state.
It preserves approved claims, customized queries, published content, external
receipts and previous event hashes. Historical evidence and upstream names
retain their original spelling and URLs.
