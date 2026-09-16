# SHSY Agent Seller Lab — Track A

## Objective

Operate one real paid endpoint for autonomous agents and learn seller economics directly. The first 14-day KPI is not revenue; it is **distinct external paying buyers** and **repeat-paying buyers**.

## Product v0

`POST /api/korea/company/evidence`

A Korean-company evidence and reconciliation result for agents. This is not a proprietary-company-data claim. The service combines verifiable public/upstream evidence, reconciles conflicts, timestamps sources, and returns `unknown` when evidence is insufficient.

### Input

```json
{
  "company_name": "Example Korea Co., Ltd.",
  "domain": "example.co.kr"
}
```

### Output contract

```json
{
  "query": {},
  "matched_entity": null,
  "match_confidence": null,
  "legal_name": null,
  "english_name": null,
  "operating_status": "unknown",
  "representative": null,
  "address": null,
  "website": null,
  "recent_activity": null,
  "recent_filings": [],
  "hiring_signal": "unknown",
  "evidence": [],
  "conflicts": [],
  "verified_at": "ISO-8601"
}
```

Every evidence item must include `source_url`, `source_name`, `observed_at`, and `fields_supported`. Never invent missing values.

## Commercial experiment

- Initial price: **$0.05 USDC / successful result**.
- Initial payment rail: **x402 on Base only**.
- Recipient address must be configured as `SHSY_PAY_TO`; never hard-code or invent one.
- Do not add MPP, cards, seller onboarding, marketplace, or routing until buyer evidence warrants it.

## Telemetry

Record only observed events:

- timestamp
- endpoint
- quoted price
- 402 issued
- payment completed / failed when observable
- payer identifier when legitimately exposed by the protocol
- first-time / repeat where derivable
- response success
- latency
- upstream cost when known
- revenue
- discovery/referrer where observable

Do not synthesize missing metrics. `payment conversion` is unavailable unless the denominator is actually observed.

## Experiment decision rules

1. Zero external payers: investigate discovery before adding products or rails.
2. External payer but no repeat: inspect result utility and next job requested.
3. Repeat payer: use the buyer's adjacent job to choose Product #2.
4. Do not call the experiment a success based on self-tests or friendly/manual purchases.

## Track B connection

SHSY is provider #0. We will use our own seller telemetry to test the same questions raised by providers: qualified demand, discovery, distinct buyer reach, repeat behavior, and whether price is actually the binding constraint.

## Remaining live inputs

- `SHSY_PAY_TO`: Base-compatible USDC receiving address controlled by SHSY.
- Evidence source credentials only if/when a selected upstream source requires them.
- Production host/domain.

Until these are configured and the endpoint is deployed, do not claim that SHSY is accepting live x402 payments.
