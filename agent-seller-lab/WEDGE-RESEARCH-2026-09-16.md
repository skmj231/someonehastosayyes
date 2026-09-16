# Track A wedge research — 2026-09-16

## Decision
Do **not** invest further in Korea Company Evidence yet. Keep it as a candidate, but current paid-market evidence favors a different first experiment.

### Strongest observed demand patterns
- General web search is heavily used: StableEnrich EXA Search ~43–44k calls/30d and 213 unique payers on its listing.
- Content retrieval is also used: StableEnrich EXA Contents ~5k calls/30d and 93 unique payers.
- People/contact enrichment shows real usage: PDL People Enrich ~1.6k calls/30d and 61 unique payers; other enrichment endpoints show hundreds to thousands of calls.
- Generic company research/enrichment endpoints are much weaker in the observed listings (often tens/hundreds of calls, sometimes single-digit buyer counts).
- A Korea-specific brokerage-research endpoint observed only 1 call / 1 payer in the current 30d listing. This is not evidence that Korea Company Evidence will attract buyers.
- Korea-specific crypto/market data is a notable exception: PrintMoneyLab's x402 server shows 557 transactions, 83 buyers and $1.60 volume over 30d across its resources; its single Kimchi Premium endpoint shows ~287 calls/30d in x402.new. This is direct evidence that autonomous buyers will pay for at least some Korea-specific machine data.

## Current ranking for first seller experiment
1. **Korea exchange / market event data for trading agents** — strongest Korea-specific observed buyer evidence and feasible from public/upstream sources. Avoid duplicating a generic kimchi-premium endpoint; favor a narrow machine-useful event feed (exchange listings/delistings/warnings/deposit-withdrawal changes, normalized in English with source/timestamp) if source feasibility checks pass.
2. **Korea-focused search/retrieval result** — rides the strongest overall paid category (search/content retrieval), but Korea-specific incremental demand is unproven and generic search is crowded.
3. **Korea business/company evidence** — strategically sensible but currently weak direct paid-demand evidence. Hold until buyer evidence or adjacent demand appears.

## Build gate before coding
For candidate #1, verify:
- official/public source accessibility and commercial-use terms;
- ability to normalize at least 3 Korean exchange announcement sources reliably;
- freshness/latency that is materially better than an agent doing ad hoc web search;
- output can be deterministic, cited, timestamped and honest about unknowns;
- no investment recommendation: descriptive events/data only.

If these fail, test candidate #2 before returning to company evidence.

## Experiment KPI
The goal remains first unrelated external payer, then repeat purchase. Do not interpret self-tests or friendly purchases as demand.