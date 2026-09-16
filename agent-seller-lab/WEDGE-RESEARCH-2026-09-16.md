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
1. **Korea exchange / market event data for trading agents — demand attractive, but currently BLOCKED pending source-rights design.** The strongest Korea-specific buyer evidence is here, but major Korean exchange Open API terms create resale risk. Upbit's terms prohibit paid distribution/licensing of programs using its Open API; Coinone prohibits transferring data obtained through the API and paid distribution/licensing of programs using it; Bithumb terms likewise restrict transfer of API-obtained data/commercial distribution. Do not build a paid resale feed on those APIs without a clearly permitted source/licence.
2. **Korea-focused search/retrieval result — current safest build candidate.** It rides the strongest overall paid category (search/content retrieval). Differentiate by Korean-language query expansion, evidence/source reconciliation, English-normalized output and freshness. Use an upstream whose terms explicitly permit our intended paid use/resale, or a paid x402 upstream designed for machine consumption.
3. **Korea business/company evidence — hold.** Strategically sensible, but current direct paid-demand evidence is weak relative to search/retrieval.

## Next product candidate
Before writing product code, validate a single endpoint concept:

`POST /api/korea/research`

Input: `{ query, mode?: "web"|"company"|"news" }`

Output: compact English-normalized JSON with Korean and English query variants, deduplicated ranked results, source URLs, source language, observed/published time where available, and explicit uncertainty/conflicts. The service must add work beyond a raw search passthrough; otherwise agents can buy Exa/Tavily/other search directly for less.

Initial differentiation hypothesis: **one paid call turns a foreign agent's question about Korea into a source-backed, bilingual, reconciled result without the agent having to know Korean sources or perform multi-step search/read/normalize itself.**

## Build gate before coding
- Confirm upstream/source terms permit the intended commercial use.
- Benchmark one representative query against buying generic search directly: SHSY must save calls/tokens or produce materially better Korean coverage.
- Keep upstream cost comfortably below test price.
- Output must be deterministic where possible, cited, timestamped and honest about unknowns.
- No investment recommendation; descriptive information only.

## Experiment KPI
The goal remains first unrelated external payer, then repeat purchase. Do not interpret self-tests or friendly purchases as demand.