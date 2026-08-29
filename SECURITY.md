# Security

## Report a vulnerability

Do not open a public issue for a vulnerability or include real API keys, approval links, Slack tokens, callback URLs, or customer context in an issue.

Email the maintainer privately with:

- the affected endpoint or file;
- steps to reproduce with test data;
- the impact you observed;
- a suggested fix, if you have one.

The maintainer should acknowledge a report within 2 business days, provide a first assessment within 5 business days, and publish a fix before disclosing technical details.

## Supported deployment

The hosted service is designed for one Node process with one persistent SQLite volume. Production requires HTTPS, non-default API and admin secrets, and a persistent `DB_PATH`.

Private or local callback addresses are rejected by default. A self-hosted operator may opt in with `ALLOW_PRIVATE_CALLBACKS=true` only when the network boundary is trusted.

Approval links are bearer secrets. They are excluded from referrer headers and browser caching, but users should still share them only with intended approvers.

## Operational minimum

- Keep Node.js and dependencies patched.
- Back up the SQLite database and test restoring it.
- Store Railway and Slack credentials only in the deployment secret store.
- Rotate an API key immediately if it appears in logs, screenshots, tickets, or chat.
- Monitor `/health` and callback failures from `/v1/stats`.
