# AI-proposed database change approval — VERIFIED

Original practitioner case: https://community.n8n.io/t/approvals-for-webapp-triggered-workflows/196116

## Approval Insert

- Protected action: execute the AI-proposed create, update, or delete operation.
- Trigger: the web app user asks the n8n agent to change database records.
- Approver: the same web app user who requested the change.
- Review: environment, operation, table, target filter, expected affected rows, safe before/after summary, and SHA-256 command hash.
- Approved: execute the exact hashed command once and return the result to the web app.
- Rejected: change nothing and return the rejection.
- No response: expire as rejected and leave the database unchanged.
- Before: web app → n8n AI Agent → MCP.
- After: SQL database → web app result.
- Idempotency key: `db-change-{request_id}-{command_sha256}`.
- Final check: authenticated `GET /v1/approvals/{id}`; require `status=approved`, then recompute and compare the command hash before the database node.

Never put a database password, connection string, API key, or unrestricted row dump in the approval context.

## Connected verification standard

Use a disposable table and a test row. Pass approve, reject, timeout, duplicate request/click, email or Slack delivery, callback, authenticated result lookup, command-hash mismatch blocking, and protected-action replay blocking in a real connected n8n workflow.

## Connected test record — 2026-09-09

- Passed: email delivery accepted by the provider, approve, reject, 60-second test timeout, duplicate request returning the same approval ID, duplicate click returning the recorded decision, callback, authenticated result lookup, and correct approve/reject/expired routing.
- Connected decision evidence: approve, reject, timeout, duplicate request and duplicate click each reached the expected route. The callback used the approval ID to fetch the authenticated final result before any database action.
- Disposable database setup: a connected n8n Data Table held one fictional test row with an approved pre-change state.
- Exact approved command: the approval bound the target filter and update value in `command_json`. The authenticated lookup and hash check passed, then the protected action changed exactly one matching test row from `pending` to `approved`.
- Historical replay failure: the first implementation showed that checking the approval ID alone did not stop the protected update node from running again. The row value stayed `approved`, but this was correctly treated as a failed action-level idempotency test.
- Replay fix: the protected update now requires both the approved target key and its approved pre-change state (`external_id=row-001` and `status=pending`). This makes the database write itself conditional instead of relying only on callback routing.
- Connected replay retest: the first callback changed exactly one row. Reposting the same approved callback returned no protected-action output and changed zero rows because the approved pre-change condition no longer matched.
- Intentional mismatch: a request stored a deliberately incorrect command hash. After approval, the callback recomputed the hash, took the false branch, and did not run the database node.
- Production default restored to 60 minutes after the timeout test.
- The disposable Data Table action was deactivated after the test. Temporary approval-link output was removed, and the production timeout remains 60 minutes.
- Verification result: every applicable path above passed in the connected n8n workflow. The earlier replay failure remains documented because it led to the conditional-write fix and successful retest.
