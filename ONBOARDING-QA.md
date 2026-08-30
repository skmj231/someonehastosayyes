# Landing onboarding QA — 2026-08-31

This file records what a non-developer can actually do from the landing page. It is also a guardrail against presenting a guide as a native integration.

## Shared journey

The page now follows one decision at a time:

1. Understand the product from the headline and approval flow.
2. Try both sides with the 20-second demo; no key or account is needed.
3. See how the Relay.app approval step maps to the existing automation tool.
4. Check reliability before installing.
5. Choose one tool and see only its setup path.
6. Request the private API key used by that guide.

Desktop and 390 px mobile checks passed without horizontal page overflow. Tabs work by click and arrow keys. The Make and Zapier copy buttons work, and a tool-specific key link preselects that tool plus the easiest email delivery option.

## n8n journey

- Interest: clear human-approval outcome before any implementation detail — pass.
- Understand: flow visual and live demo explain pause → decision → resume — pass.
- Test: demo approval records one decision and updates the original page — pass.
- Apply: the n8n panel explains the exact three-value workflow path — pass.
- Decide: operational behavior is visible before setup — pass.
- Install: hosted email starter downloads as valid JSON with six connected nodes — pass.

Remaining friction: a reviewed API key still has to be pasted once. The new email starter itself has not yet been imported into a completely fresh third-party n8n account during this change; it uses the same tested HTTP Request → Wait → IF structure as the existing Slack starter.

## Make journey

- Interest, understanding, and demo — pass.
- Apply: the panel explains why two scenarios are used and which one to build first — pass.
- Decide: no claim of native or one-click installation — pass.
- Install: exact clicks, endpoint, request body, and copy controls are available without leaving the landing page — pass with limitation.

Limitation: Make needs a receiving scenario and a requesting scenario. There is no downloadable, fresh-account-tested blueprint in this release. Keep the label “Guided setup,” not “Install” or “one click,” until a blueprint has been imported and tested in a clean Make account for approval, rejection, cancellation, and timeout.

## Zapier journey

- Interest, understanding, and demo — pass.
- Apply: the two-Zap Catch Hook → Custom Request pattern is explained in plain language — pass.
- Decide: the page discloses that this is not a native Zapier app and requires a paid Webhooks plan — pass.
- Install: exact clicks, endpoint, request body, and copy controls are available without GitHub — pass with material limitation.

Limitation: Zapier itself treats Webhooks as an advanced, paid feature. Do not market this as a native Zapier integration. A truly beginner-level Zapier install requires a reviewed Zapier app or template and a fresh-account installation test.

## Release guardrails

- Do not add “one-click,” “native Make integration,” or “native Zapier integration” until those statements are verified in fresh accounts.
- Keep the beginner path on email first; Slack can be selected after the first successful approval.
- Keep API documentation as a separate developer path, not the default setup path.
- Retest all four panels, copy controls, tool preselection, mobile overflow, and starter downloads whenever the onboarding section changes.
