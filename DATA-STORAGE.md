# SHSY data storage and secret controls

This is the current storage map and the checklist used to verify it. It applies to the hosted service and self-hosted copies of the same application.

## Storage location

SHSY uses one SQLite database in WAL mode.

- Local default: `askhuman.db` in the application working directory.
- Production: `DB_PATH`, normally `/data/someonehastosayyes.db` on a persistent Railway volume.
- The database, `-wal`, `-shm`, snapshots and downloaded backups must all be treated as sensitive production data.
- Application secrets belong in the deployment secret manager, never source control or approval context.

## Stored data

| Area | Stored fields | Purpose | Default retention |
| --- | --- | --- | --- |
| Approval | question, minimum decision context, labels, recipient, callback URL, timeout rule, status and timestamps | present and enforce one decision | completed records: 90 days |
| Decision | result, decider label, time and optional comment | return and audit the human answer | 90 days |
| Delivery | email/Slack attempts, provider reference and errors | retry and diagnose delivery | 30 days |
| Callback | endpoint, signed body, attempts and errors | reliably return the result | 30 days |
| Receipt | signed decision receipt and key id | detect alteration after the decision | 365 days |
| Account access | email, platform choice, verification and review state | issue and manage access | while the account/key is active |
| Operations | usage, risk, incidents, cost and goal progress | operate limits and measure product outcomes | policy-specific |

## Secret protection

| Secret | Stored form | Control |
| --- | --- | --- |
| API key | never stored raw | SHA-256 hash plus a short display prefix |
| Email verification token | never stored raw | SHA-256 hash, expiry and one-use timestamp |
| Slack bot token | encrypted at rest | AES-256-GCM envelope (`enc:v1`) before SQLite write |
| Ed25519 signing private key | deployment secret or encrypted at rest | `SIGNING_KEY`; otherwise an AES-256-GCM envelope in `meta` |
| Slack/Resend/admin credentials | not stored in SQLite | deployment environment secrets only |

`DATA_ENCRYPTION_KEY` is the dedicated encryption secret. It must be at least 32 characters and remain stable across deploys. For backward-compatible deployments, the already-required `SIGNING_SECRET` is used only when `DATA_ENCRYPTION_KEY` is absent. New production installations should set a separate `DATA_ENCRYPTION_KEY`.

At startup, existing plaintext Slack tokens and a legacy plaintext database signing key are migrated in place to encrypted envelopes. Changing or losing the encryption secret makes those values unrecoverable, so rotate it only through a planned decrypt-and-re-encrypt migration.

## Data minimization

An approval should contain only:

1. the action about to happen;
2. the few fields needed to judge it; and
3. a stable reference to the source system.

Never put passwords, API keys, session tokens, full customer records, health data, payment card data or unrelated conversation history in `question` or `context`.

## Verification checklist

Run this against a copy of the production database, not the live file:

```bash
node storage-audit.js /path/to/snapshot.db
```

It fails when a Slack token or stored signing key is plaintext, or when an API/verification credential is not represented by a one-way hash.

Production review:

- `DB_PATH` points inside the persistent volume.
- `DATA_ENCRYPTION_KEY`, `SIGNING_SECRET`, `ADMIN_SECRET`, provider credentials and optional `SIGNING_KEY` are deployment secrets.
- database and backup access is limited to operators who need it.
- a restored snapshot passes `storage-audit.js` before use.
- `GET /v1/retention` matches the policy above.
- deletion endpoints are tested with non-production records.
- encryption-secret recovery is included in the backup procedure separately from the database backup.

This audit intentionally reports structure and protection state without printing secret values.
