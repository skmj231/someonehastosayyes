# AI-proposed database change approval — TESTING

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

## Harmless connected test required

Use a disposable table and a test row. Pass approve, reject, timeout, duplicate request/click, email or Slack delivery, callback, authenticated result lookup, and command-hash mismatch blocking. Keep the template `TESTING` until every applicable path passes in a real connected n8n workflow.
