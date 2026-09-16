# SHSY Agent Seller Lab

[Current execution and evidence record](EXECUTION-2026-09-17.md) · [Track B posture](TRACK-B-OUTREACH.md)

One deterministic product, one payment rail, one actual external buyer as the completion threshold. Current product is Email Preflight; older Korea Company Evidence notes are superseded.

Required operator input: `SHSY_PAY_TO`, the SHSY-controlled Base USDC receiving address. Optional `SHSY_TEST_PAYERS` is a comma-separated list of self/friendly wallets excluded from demand.

Other configuration: `SHSY_PRICE_ATOMIC=1000` (USDC has six decimals); `SHSY_EXPERIMENT_ID=email-preflight-v1`. Existing `SIGNING_SECRET` protects payer hashes, so rotating it changes pseudonymous identity continuity. Existing `ADMIN_SECRET` protects `/admin/seller/telemetry`.

The default PayAI facilitator requires no API keys for its available free allowance. At 2026-09-21 12:00 UTC the default path stops taking payments for cost review. Existing CDP configuration may be used with `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`; never paste secrets into research files or source control.

Test: `npm run test:seller`. Mock payments have no relationship to real demand. Never count an unclassified wallet as a verified external agent without reviewing evidence.
