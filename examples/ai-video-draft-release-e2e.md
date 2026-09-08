# AI video draft release approval — connected E2E evidence

Verified against the production SHSY API and a real Make account on 8 September 2026 (KST). The protected action was a harmless `release_authorized` variable; no video was publicly rendered or posted.

| Path | Evidence | Result |
| --- | --- | --- |
| Approval creation | Connected Make test scenario; production `POST /v1/approvals` | `201`, pending approval created |
| Duplicate request | The same Make run repeated the request with the same `Idempotency-Key` | `200`, same approval ID; duplicate guard passed |
| Email notification | Connected test approval; operational ID retained privately | `delivered`, one attempt, no delivery error |
| Approve | Connected test approval; operational ID retained privately | Final state `approved` |
| Approved callback | Connected Make callback run; operational IDs retained privately | Three operations; authenticated GET and release filter passed |
| Version binding | Release filter compared approval ID, `draft_sha256`, `draft_version`, and `destination` | Exact reviewed draft only; harmless release marker ran once |
| Slack notification | Connected test approval and channel; operational IDs retained privately | Slack workspace connected; `delivered`, one attempt, no delivery error |
| Reject | Connected test approval; operational ID retained privately | Final state `rejected`; authenticated GET succeeded; release filter blocked |
| Timeout | Connected test approval with one-minute QA timeout; operational ID retained privately | Final state `rejected`; callback delivered; release filter blocked |

The public template may be marked `VERIFIED` because every applicable outcome passed in the connected workflow. Provider `delivered` means the email/Slack provider accepted the notification; it is not a guarantee that an email client placed the message in its primary inbox.
