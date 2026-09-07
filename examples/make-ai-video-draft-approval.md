# AI video draft release approval in Make

Source case: https://community.make.com/t/pattern-for-pausing-a-make-scenario-while-a-human-reviews-an-ai-video-draft/112270

This insert sits after the draft URL is ready and before final render or publish. Make keeps the trigger and final action. SHSY owns the pending decision, single-use link, timeout, idempotency, callback, and authenticated result.

## Exact contract

| Field | Value |
| --- | --- |
| Protected action | `video.publish` |
| Trigger | A designer attaches a new AI video draft URL and marks it ready for review |
| Approver | Assigned creative lead or client reviewer |
| Review information | Draft URL, original brief, prompt summary, version, SHA-256 hash, destination |
| Approved | Release that exact version, hash, and destination once |
| Rejected | Publish nothing; return the draft for revision with the comment |
| Timeout | Reject and keep release blocked |
| Idempotency key | Stable request ID plus draft version or hash |

## Scenario A: create the approval

Add one Make HTTP v4 request after the draft URL is ready.

- Method: `POST`
- URL: `https://someonehastosayyes.com/v1/approvals`
- Authentication: API key stored in the Make secure keychain
- Header: `Idempotency-Key: ai-video-{{request_id}}-{{draft_sha256}}`
- Body content type: JSON
- Return error if HTTP request fails: Yes

```json
{
  "question": "Release AI video draft {{draft_id}} {{draft_version}} to {{destination}}?",
  "context": {
    "request_id": "{{request_id}}",
    "draft_id": "{{draft_id}}",
    "draft_url": "{{draft_url}}",
    "draft_version": "{{draft_version}}",
    "draft_sha256": "{{draft_sha256}}",
    "original_brief": "{{original_brief}}",
    "prompt_summary": "{{prompt_summary}}",
    "destination": "{{destination}}",
    "reviewer_role": "Creative lead"
  },
  "actor": { "type": "automation", "id": "{{make_scenario_id}}" },
  "principal": { "type": "role", "id": "creative-lead" },
  "action": { "name": "video.publish" },
  "resource": { "type": "video_draft", "id": "{{draft_id}}", "version": "{{draft_version}}" },
  "constraints": { "draft_sha256": "{{draft_sha256}}", "destination": "{{destination}}" },
  "approve_label": "Release this version",
  "reject_label": "Send back for changes",
  "channel": "email",
  "to": "{{reviewer_email}}",
  "callback_url": "{{scenario_b_custom_webhook_url}}",
  "timeout_minutes": 1440,
  "default_on_timeout": "rejected"
}
```

## Scenario B: authenticate before release

Create a Custom webhook, then add one authenticated HTTP GET:

`GET https://someonehastosayyes.com/v1/approvals/{{webhook.id}}`

The filter before the release module must require all of these:

1. Authenticated response `status` equals `approved`.
2. Authenticated response `id` equals the callback `id`.
3. Authenticated response `context.draft_sha256` equals the callback hash.
4. Authenticated response `context.draft_version` equals the callback version.
5. Authenticated response `context.destination` equals the callback destination.

Connect the final renderer or publish module only after this filter. A callback by itself is never proof of approval.

## Verification checklist

- Approve: the exact reviewed version reaches the harmless staging release step once.
- Reject: the release filter blocks it.
- Timeout: one-minute QA timeout rejects and blocks release.
- Duplicate request: the same idempotency key returns the same approval ID.
- Duplicate click: only the first decision is recorded and only one callback is delivered.
- Notification: the approval request arrives in the configured email or Slack destination.
- Callback: Scenario B runs once per final decision.
- Authenticated lookup: Scenario B retrieves the final decision with the stored SHSY credential before branching.

Keep the public template marked `TESTING` until every applicable item above passes in a real connected Make account.
