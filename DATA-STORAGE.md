# SHSY data storage

This document describes the data stored by the current SHSY application, where it is stored, and how long it is retained.

## Storage location

SHSY uses one SQLite database.

- Local/default: `askhuman.db` in the application working directory.
- Production: the path set in `DB_PATH`. Railway should mount a persistent volume at `/data` and set `DB_PATH` to a file inside that volume, for example `/data/someonehastosayyes.db`.
- SQLite runs in WAL mode. The database file and its WAL files must remain on the persistent volume.

The application does not send approval records to a separate analytics warehouse. Operational and product events are stored in the same SQLite database.

## What is stored

| Area | Stored data | Why it is needed |
| --- | --- | --- |
| Approval request | Question, structured context, action labels, delivery channel, recipient, callback URL, timeout policy, status, timestamps and idempotency key | Display the decision, enforce one decision, and resume the original automation |
| Decision | Approved/rejected/expired state, decider label, decision time and optional comment | Return and audit the final human decision |
| Delivery | Email/Slack attempts, delivery status, retry count, provider references and errors | Retry failed delivery and diagnose missing notifications |
| Callback | Callback attempts, response status, retry count and errors | Reliably return the decision to Make, Zapier, n8n or another caller |
| Receipt | Signed authorization receipt and archived receipt metadata | Prove which decision was recorded and detect later alteration |
| Account and key request | Email, selected platform, requested delivery method, verification state and review state | Issue and manage API access |
| API credential | Key prefix, one-way key hash, state, plan, permissions and usage limits | Authenticate API calls without retaining the raw API key |
| Verification | One-way verification-token hash, expiry and used time | Confirm email ownership without letting link scanners issue a key |
| Slack installation | Workspace/team identifiers, installation metadata and bot token | Deliver approval requests to the connected Slack workspace |
| Operations | Usage counters, risk signals, incidents, cost ledger and operational events | Enforce limits and operate the service safely |
| Product progress | Anonymous funnel events and account milestones | Measure whether users reach a real approval and production action |
| Product goals | Long-term, short-term and current goal definitions, targets and status | Keep product work aligned with the current objective |

## Secrets and sensitive fields

- The raw API key is displayed once and is not stored. Only a one-way hash and a short prefix are retained.
- Email verification tokens are stored as one-way hashes.
- Approval and callback URLs may contain customer identifiers or payload context. Users should send only the information the approver needs.
- Slack bot tokens are currently stored in the SQLite database so the service can deliver messages. Protect the production volume and database backups as secrets.
- If `SIGNING_PRIVATE_KEY` is not supplied as an environment secret, the generated signing key is stored in the database metadata. Production should supply the signing key through the secret manager.

## Retention and deletion

Current service policy:

- Pending requests: until decided, cancelled or timed out, with a maximum of 90 days.
- Completed approval records: 90 days.
- Notification and callback attempt history: 30 days.
- Signed authorization receipts: 1 year.

The API exposes the current policy at `GET /v1/retention`. A caller can delete one approval or request deletion of all data associated with its credential through the documented deletion endpoints.

## Data minimization rule

An approval should contain the smallest useful decision packet: the action about to happen, the fields required to judge it, and a stable reference back to the source system. Full customer records, credentials, secrets and unrelated conversation history should not be placed in approval context.
