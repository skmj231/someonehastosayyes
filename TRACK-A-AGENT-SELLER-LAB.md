# Track A — Agent Seller Lab

## Goal
Become a real participant in the agent-payment economy by operating one paid endpoint and measuring real buyer behavior. The first milestone is not revenue; it is one unrelated external payer, followed by a repeat purchase.

## Public credibility page
Intended production path: `https://someonehastosayyes.com/agent-seller`

The page is deliberately minimal: white background and one headline only.

> We operate paid APIs for autonomous agents and study how agents discover, evaluate, and purchase machine services.

Source file: `agent-seller.html`.

## Product under test
**Korea Company Evidence**

One agent-facing action: given a Korean company name and optional domain, reconcile public evidence into a structured result. This is not positioned as proprietary company data. The value hypothesis is evidence reconciliation for agents that would otherwise need to search several Korean-language/public sources and resolve conflicts themselves.

### Proposed contract
`POST /api/korea/company/evidence`

Input:
```json
{"company_name":"Example Korea","domain":"example.co.kr"}
```

Output fields:
- matched_entity / match_confidence
- legal_name / english_name
- operating_status
- representative / address / website
- recent_activity / recent_filings / hiring_signal
- evidence[] with source URL, observed time, supported fields
- conflicts[]
- verified_at

Rules:
- Never invent a field.
- Unknown stays unknown/null.
- Conflicting evidence is surfaced, not silently reconciled.
- Every material assertion needs evidence.

## Commercial experiment
- One endpoint only.
- Initial test price: **$0.05 USDC per successful call**. This is a test price, not an optimum claim.
- Initial payment rail: **x402 on Base only**.
- Payment recipient must be supplied via `SHSY_PAY_TO`; never hard-code or invent a wallet.
- Do not add MPP/cards/marketplace/routing until real buyer evidence requires it.

## Telemetry to record
Only real observed events:
- timestamp
- endpoint
- quoted price
- whether 402 was issued
- payment completed / failed when observable
- payer wallet or protocol identifier when legitimately exposed
- first-time vs repeat payer when derivable
- response success
- latency
- upstream cost when known
- revenue
- discovery/referrer when available

Do not synthesize missing events. A metric whose denominator is not observed is `unavailable`, not zero.

## 14-day decision rules
Primary evidence:
1. distinct external paying wallets
2. repeat-paying wallets / repeat rate
3. paid calls
4. discovery source when observable
5. gross margin after upstream cost

Interpretation:
- **0 external payers:** do not add products. Test discovery/listing and demand assumptions first.
- **1+ external payer, no repeats:** inspect the purchased job and discovery path before expanding.
- **repeat payer:** strong reason to investigate adjacent jobs requested by that buyer.
- Product #2 must come from observed buyer behavior/request, not brainstorming.

## Remaining inputs before a live paid endpoint
1. Real Base USDC receiving address (`SHSY_PAY_TO`).
2. Production evidence-source choice/credentials where public direct sources are insufficient.
3. Production route wiring for `/agent-seller` and the paid API endpoint.
4. x402 V2 integration and paid-retry test.
5. Discovery registration after the endpoint is actually live.

## Explicitly out of scope
- seller marketplace
- third-party seller onboarding
- multi-rail payments
- routing/meta API
- multiple speculative products
- fabricated benchmarks or transactions
