# Sensitive HR message release approval — VERIFIED

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

## Connected verification standard

Use fictional employees and a private test destination. Pass approve, reject, timeout, duplicate request/click, email or Slack delivery, callback, authenticated result lookup, message-hash mismatch blocking, raw-data exclusion, and one real private action delivery in a connected n8n workflow.

## Connected test record — 2026-09-09

- Passed: raw HR values excluded before SHSY, email delivery accepted by the provider, approve, reject, 60-second test timeout, duplicate request returning the same approval ID, callback, authenticated result lookup, and correct approve/reject/expired routing.
- Connected decision evidence: approve, reject, timeout, duplicate request and duplicate click each reached the expected route. The callback used the approval ID to fetch the authenticated final result before any message action.
- Intentional mismatch: a request stored a deliberately incorrect message hash. After approval, the callback recomputed the hash, took the false branch, and did not run the message-send node.
- Production default restored to 60 minutes after the timeout test.
- Actual private action send: **PASSED**. A Slack OAuth credential was connected to an owned test workspace. A request containing only fictional data reached the approved branch after the authenticated result lookup and message-hash comparison.
- Delivery evidence: the connected Slack node returned one successful result. The message was then visibly inspected in the owned private test channel.
- Receipt inspection: the received message contained the approval reference, a fictional recipient, the sanitized test-only copy, and the result `approved and hash verified`. No real employee or HR data was used.
- Temporary approval-link output was removed after the test. The connected Slack node remains on the verified approved path; the unused email node remains deactivated.
- Verification result: every applicable path above passed in the connected n8n workflow.
