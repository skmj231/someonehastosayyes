# Sensitive HR message release approval — TESTING

Original practitioner case: https://www.reddit.com/r/n8n/comments/1tjamdb/how_are_people_checking_aigenerated_slackgmail/

## Approval Insert

- Protected action: send the checked HR message to Slack, Gmail, or a CRM.
- Trigger: a deterministic PII check flags an AI-written message for human review.
- Approver: the responsible HR owner or manager.
- Review: recipient, delivery channel, sanitized final message, sensitivity flags, removed-field names, and SHA-256 message-and-destination hash.
- Approved: send the same sanitized message to the same recipient and channel once.
- Rejected: send nothing and return the draft for revision.
- No response: expire as rejected and send nothing.
- Before: HR system → n8n AI draft → deterministic PII check.
- After: Slack, Gmail, or CRM.
- Idempotency key: `hr-message-{request_id}-{message_sha256}`.
- Final check: authenticated `GET /v1/approvals/{id}`; require `status=approved`, then recompute and compare the message, recipient, and channel hash before sending.

The raw HR record is deliberately excluded. Do not send salary, review notes, phone numbers, API keys, or original HR fields to SHSY. Only the sanitized final message and the names of removed field types belong in the approval.

## Harmless connected test required

Use fictional employees and a private test destination. Pass approve, reject, timeout, duplicate request/click, email or Slack delivery, callback, authenticated result lookup, message-hash mismatch blocking, and raw-data exclusion. Keep the template `TESTING` until every applicable path passes in a real connected n8n workflow.
