# AI video draft release approval — connected E2E evidence

Verified against the production SHSY API and a real Make account on 8 September 2026 (KST). The protected action was a harmless `release_authorized` variable; no video was publicly rendered or posted.

| Path | Evidence | Result |
| --- | --- | --- |
| Approval creation | Make scenario `6184074`; production `POST /v1/approvals` | `201`, pending approval created |
| Duplicate request | The same Make run repeated the request with the same `Idempotency-Key` | `200`, same approval ID; duplicate guard passed |
| Email notification | Approval `apr_17af00ee36ca92d4` | `delivered`, one attempt, no delivery error |
| Approve | Approval `apr_17af00ee36ca92d4` | Final state `approved` |
| Approved callback | Make callback scenario `6183957`, run `c19220b0065948bf8a493fc96feede3e` | Three operations; authenticated GET and release filter passed |
| Version binding | Release filter compared approval ID, `draft_sha256`, `draft_version`, and `destination` | Exact reviewed draft only; harmless release marker ran once |
| Slack notification | Approval `apr_2190fd2540dd2bd9`, channel `C0BTLPD79CJ` | Slack workspace connected; `delivered`, one attempt, no delivery error |
| Reject | Approval `apr_2190fd2540dd2bd9` | Final state `rejected`; authenticated GET succeeded; release filter blocked |
| Timeout | Approval `apr_23a4893062008d73`, one-minute QA timeout | Final state `rejected`; callback delivered; release filter blocked |

The public template may be marked `VERIFIED` because every applicable outcome passed in the connected workflow. Provider `delivered` means the email/Slack provider accepted the notification; it is not a guarantee that an email client placed the message in its primary inbox.
