# Track A — Email Preflight

Current authoritative execution record: [2026-09-17](agent-seller-lab/EXECUTION-2026-09-17.md).

Goal: one unrelated external agent/bot pays on Base and receives a successful result. Tests, implementation, deployment and listings do not complete the goal.

Product: `POST /api/agent/email-preflight`, `{"email":"person@example.com"}`. Public page: `/agent-seller`; schema: `/agent-seller/openapi.json`; agent docs: `/llms.txt`.

Initial experimental price: $0.001 USDC. Real receiver: `SHSY_PAY_TO`, supplied by SHSY. No invented address and no server wallet private key. Payments remain disabled without it. Default PayAI path pauses at its announced 2026-09-21 12:00 UTC pricing change until reviewed.

Korea Company Evidence / Korea Research are deferred. Email Preflight does not verify mailbox existence. See the execution record for evidence, competitive limitations, telemetry, tests and the distribution queue.
