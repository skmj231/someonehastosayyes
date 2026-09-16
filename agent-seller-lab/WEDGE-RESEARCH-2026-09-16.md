# Track A wedge research — 2026-09-16

## Final pre-build decision
Do **not** build Korea Company Evidence or vague Korea Research as the first seller experiment.

The immediate objective is not to prove a long-term moat. It is to become a real x402 seller quickly, observe discovery/payment/repeat behavior, and gain seller-side credibility. Therefore the first product should be a small, deterministic job with already-observed paid demand and minimal upstream dependency.

## Market evidence that changed the decision
- Search demand is real, but a generic search clone is not a clean experiment: StableEnrich EXA Search is ~$0.01/call with ~43–44k calls/30d and 213 unique payers, while Exa direct is cheaper at ~$0.007/call and still has ~6k calls/30d. This shows lowest price is not the only selection variable; distribution, trust, integration context and listing position may matter.
- More processing does not automatically win: one-call search+scrape examples can have negligible usage. Therefore “fewer steps” is a hypothesis, not a proven purchasing rule.
- Result-shaped workflows do sell: Research Person (~$0.05) has hundreds of calls; EXA Answer (~$0.011) has ~1.5–1.9k calls; people/contact enrichment has meaningful activity.
- A particularly low-complexity proven job is email verification. Oneshotagent Verify Email is listed around $0.001/call with several thousand calls/30d. Competing email-validation endpoints at materially higher prices can also have calls, but some are highly concentrated in only a few payers. Price alone therefore cannot be treated as the reason for demand.

## First seller experiment: Email Preflight
Build one deterministic x402 endpoint:

`POST /api/agent/email-preflight`

Input:
```json
{"email":"person@example.com"}
```

Return only evidence we can compute honestly without mailbox intrusion:
- normalized email
- syntax_valid
- domain
- mx_present + MX hosts
- disposable_domain
- role_account
- free_provider
- SPF present
- DMARC present
- typo/suggested_domain when high confidence
- risk flags
- checked_at
- explicit `mailbox_exists: unknown` unless a legitimate method actually establishes it

### Why this is first
1. Existing paid demand is directly observable.
2. Implementation is small and deterministic.
3. No proprietary dataset is required to launch (aside from maintained public lists/rules where licensing permits).
4. Upstream variable cost can be near zero using DNS/public rule data.
5. It can be cheaper than many richer validators, but the experiment is NOT based on price alone.
6. It gets SHSY into the same discovery → 402 → payment → repeat loop quickly.

### Price hypothesis
Test at **$0.001 USDC/call** initially. Do not undercut merely for its own sake. If discovery produces impressions/402s but no payment, price can become a later variable. If there is no discovery/exposure, changing price teaches nothing.

## What this experiment can and cannot prove
It can teach us:
- whether SHSY is discovered at all;
- whether an unknown external buyer pays;
- whether buyers repeat;
- whether listing wording/category/metadata matter;
- operational x402 payment/telemetry realities;
- whether our own seller experience matches provider complaints about qualified demand/discovery.

It cannot prove:
- that cheaper always wins;
- that reducing API steps always wins;
- that email verification is SHSY's long-term business;
- that observed wallets equal distinct economic buyers.

## Evidence on the “cheaper / fewer steps” thesis
Current evidence supports only a weaker claim: **agents do not simply choose the cheapest endpoint.** A higher-priced wrapper around the same upstream can receive more observed usage than the upstream's direct x402 endpoint. Conversely, some one-call bundled workflows show almost no usage. The likely selection function includes discovery/ranking, trust/reputation, schema fit, latency/reliability, prior integration, price and task completion quality. Track A exists to measure those variables firsthand.

## Product #2 rule
Do not preselect Korea Research as Product #2. Product #2 must come from observed buyer behavior, search/discovery evidence, or an adjacent request from a real payer.

## KPI
First unrelated external payer, then repeat purchase. Self-tests/friendly purchases do not count as demand.