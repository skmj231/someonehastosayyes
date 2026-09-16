# Track A execution — 2026-09-17 KST

## Completion condition
One paid purchase by an unrelated external agent/bot, supported by a Base transaction and a successful SHSY response. Code, a deployment, a directory listing, mocks, self-tests and friendly/manual purchases do not complete the goal. Current verified purchases: **0**. No live receiver was supplied at implementation time.

## Second market review and decision
Retain Email Preflight as a bounded first seller experiment. Evidence supports some paid-address-check activity, not broad demand or causality. SHSY is weaker than a real mailbox verifier when the task is “can this exact inbox receive mail?” Sell the narrower job honestly: filter obvious problems, return DNS/list evidence and explicit uncertainty in one synchronous response.

Observed 2026-09-16 15:28–15:33 UTC (2026-09-17 KST):

| Candidate | Advertised price | Directory 30d calls / payers | Direct unpaid probe | Interpretation |
|---|---:|---:|---|---|
| OneShot Verify Email | $0.001 | ~5.8k / 13 | 402; v2 Base USDC offer confirmed | Best breadth of these three, still only wallet identifiers. Documentation claims mailbox existence, async job + polling; SHSY is not equivalent. |
| Strale Email Validate | $0.0324 | ~2.3k / 2 | 402; v1 offer, GET email parameter | Higher-price volume is concentrated. Neither price elasticity nor independent buyer count can be inferred. |
| Hugen Mailcheck Validate | $0.01 | 16 / 2 | 402; static sample + payment header | Similar check bundle; features alone do not establish demand. Gateway/SDK distribution is an advantage. |

Sources: [OneShot listing](https://x402.new/services/win-oneshotagent-com-v1-tools-verify-email), [OneShot product contract](https://docs.oneshotagent.com/api-reference/verify/email.md), [Strale listing](https://x402.new/services/api-strale-io-x402-email-validate), [Hugen listing](https://x402.new/services/mailcheck-hugen-tokyo-mailcheck-validate). Full observed offers and directory snapshots are in `evidence/`. Their “last called” label was Sep 10. These are directory-reported rolling counts, not independently audited purchases. An older x402ui snapshot reports OneShot 232 calls / 2 payers as of Aug 15; do not combine windows or call this independent corroboration.

An inferred Ai Rook route returned 404. Its endpoint path was not independently verified; exclude it from reliability comparisons.

## Purchase-factor comparison

| Factor | Evidence / gap | SHSY launch response | What can actually be measured |
|---|---|---|---|
| Discovery | Competitors have indexed listings and larger product families | Public agent docs, OpenAPI, Bazaar metadata, then submit live endpoint | Docs/schema requests; source-tagged requests. Directory impressions remain unknown unless provided. |
| Job/schema fit | OneShot claims deeper mailbox checks; Strale is closer to our scope | Explicit preflight job; complete result schema; no generic “verified email” claim | Valid job requests, validation errors, paid execution; qualified intent remains a proxy. |
| Reliability | All three direct probes returned 402 once | Failed DNS gets 503 without settlement; replay guard | Per-stage failures, HTTP result status, settlement status. No uptime claim yet. |
| Latency | Single unpaid probes: 539 / 518 / 867 ms locally | Parallel bounded DNS lookups; synchronous JSON | Per-stage timing. Unpaid probe latency is not paid result latency and is not a benchmark. |
| Seller trust/history | Established providers show directory history; SHSY has none for this product | Existing SHSY domain, open code, source evidence and candid limitations | Repeat wallets + incidents. Trust's causal effect is unknown. |
| Integration | OneShot SDK/jobs; Hugen gateway; Strale GET schema | POST body, x402 v2, no SHSY account, machine-readable schema | Quote→verify failures, repeated schema errors. |
| Completeness | Our scope does not include SMTP/catch-all/reputation | Syntax, MX/null-MX/fallback, disposable match/version, role/free-provider rules, typo, exact-domain SPF/DMARC presence | Requested additions and purchase/repeat outcomes. |
| Price | Higher-price Strale volume has 2 payers, lower-price OneShot has 13 | Start $0.001; record price and experiment ID | Compare sequential cohorts only with attribution/sample caveats. Never infer causal elasticity from raw ratios. |

## Product contract and boundaries
POST `/api/agent/email-preflight`, body `{"email":"person@example.com"}`. No LLM, no SMTP probe, no email sending. No mailbox-existence or delivery guarantee. Domain normalization preserves mailbox case. Typo suggestion never rewrites the recipient. No MX alone is not treated as invalid: A/AAAA fallback follows RFC 5321 §5.1; null MX follows RFC 7505. SPF/DMARC presence is context about sending authentication, not proof of incoming delivery. DMARC parent-domain fallback and full policy validity are not implemented. `disposable-email-domains` v1.0.62 is MIT licensed; false means no list match, not proof of non-disposable status. Small explicit free/role lists are incomplete.

## Payment and operating costs
Base mainnet USDC, x402 exact/EIP-3009 only. `SHSY_PAY_TO` must be a user-supplied SHSY-controlled address. No private key is needed on this server. Default facilitator: PayAI, whose `/supported` currently advertises v2 exact Base. Optional existing CDP credentials may select CDP without changing the payment rail.

PayAI's live `/pricing` advertises a Base EIP-3009 rate of $0.00212 effective 2026-09-21 12:00 UTC. It exceeds our $0.001 experimental price. No merchant billing subscription or credit purchase was made. The default PayAI path automatically pauses at that time pending review. The current free tier is a launch allowance, not a sustainable zero-cost assumption. Fee documentation: https://facilitator.payai.network/pricing and https://docs.payai.network/x402/facilitators/pricing .

## Telemetry and honest denominators
`product_page`, `schema_view`, `agent_docs`, `api_request`, `valid_job_request`, `invalid_request`, `quote_402`, `payment_verified`, `settlement_started`, `settled`, `settlement_unknown`, `payment_canceled`, `result_prepared`, `dns_unavailable`, `result_failed`, `http_response`.

Each event has request ID, time, experiment ID, quoted atomic USDC amount, optional claimed source, latency, and status where observed. Settlements have unique nonce identity, hashed payer identity, transaction hash and result hash. No raw email or result persists. The source header is caller-claimed, not trusted proof of referral. Missing source stays null. Quotations include crawlers and retries, not unique qualified buyers. Prequote→paid requests are not automatically linked as a unique visitor. Separate quoted requests, valid signatures, settlements and HTTP finishes. Response finish does not prove the buyer used the result.

Payer classification starts `unclassified`. Receiver and configured `SHSY_TEST_PAYERS` are excluded. Wallet count is not economic-buyer count, and cross-seller market reach is unavailable. Review transaction and bot/customer evidence before recording the goal achieved. Retain the evidence in the private operating record; do not publish customer identity. The raw administrative telemetry is `/admin/seller/telemetry`, under existing admin authentication.

## Distribution and iteration queue
1. Configure real receiver; deploy and inspect production 402, schema, TLS and health.
2. Submit live resource at https://www.x402scan.com/resources/register and x402.new's visible listing flow. Do not say indexed until search/detail lookup confirms it.
3. Bazaar metadata is advertised; facilitator indexing is asynchronous and must be checked separately. Do not claim “listed” merely because an extension exists.
4. Use source tags for owned links where supported. Record actual submission/result timestamps.
5. If zero observed discovery: check registration/search/category/schema first. Do not assume low price is the cause. Absence of site traffic cannot prove whether directory users rejected a visible price.
6. If 402 but no valid payment: inspect funded-wallet/client compatibility and job/value clarity, then consider a single price or wording change.
7. If verify but no settle: fix execution/payment faults before marketing changes.
8. If settled but no useful result: investigate support and result completeness before seeking more buyers.
9. Change one main variable per iteration; stamp experiment ID and observation window. With tiny samples, report direction only, never a benchmark.
10. After first unrelated payer, verify tx chain, token, recipient, amount, success and result hash; then investigate repeated paid use. Do not induce a friendly purchase to satisfy the milestone.

Track B: keep the existing reciprocity rules in TRACK-B-OUTREACH.md. No provider emails sent during this implementation. Re-contact existing providers only on a reply or meaningful new evidence.

## Validation record
17 focused seller tests pass using isolated mock settlement, not real payments. Existing basic/key review, recovery, restart, tenant isolation, key migration, load, notification and template suites pass. Existing `test:reliability` fails on old admin UI text (`Operations`) in both unchanged main and this branch; no production behavior was altered to appease that assertion. Dependency audit: zero reported vulnerabilities after compatible patch updates. Local product page was visually inspected.
