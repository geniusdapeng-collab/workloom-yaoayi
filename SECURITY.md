# Security

This repository is open-source and local-first. Source availability does not
make any runtime data, account, model provider or external platform public.

## Never commit

- Personal access tokens, passwords, cookies, recovery codes, or private keys
- Customer data or raw private account exports
- Phone numbers, email addresses, identity documents, or home addresses
- Unapproved employment, financial, legal, or customer claims

## Runtime boundary

- The HTTP server binds to `127.0.0.1` by default.
- Platform publication is manual in v0.1.
- A publication can only be recorded with an external URL and a real or imported receipt.
- Fixture and draft data can exercise workflows but cannot prove a real publication.
- The append-only event chain is tamper-evident, not a substitute for a trusted timestamp or platform signature.

## Incident response

If a secret reaches a repository, log, screenshot, or chat:

1. Revoke and rotate it immediately.
2. Remove it from the current working tree.
3. Rewrite Git history only after coordinating the security impact.
4. Preserve an incident note without copying the secret.

## Reporting

Report vulnerabilities privately to the repository owner through GitHub's
security-advisory interface. Do not include live credentials, customer data or
private account exports in an issue, pull request, screenshot or public log.
