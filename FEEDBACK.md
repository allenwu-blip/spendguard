# Reporting a budget that didn't hold — or a possible leak

spendguard lives or dies on two things, and both matter equally:

1. **The budget actually holds** — overspend never slips through while
   spendguard claims to be guarding.
2. **It NEVER leaks** your API key or prompt/response content into a log,
   diagnostic, or persisted file.

Telling us about a failure of either is the single most useful contribution
you can make.

## 🔴 Security reports come first

If you ever see anything **key-shaped or prompt/response-shaped** in
spendguard's stdout, a log, the ledger state file, or any other file it
wrote — report it immediately and treat it as the highest priority.

- **Do NOT paste the actual key.** Describe *where* you saw it (which file
  / which log line / which command) and what it looked like — not the
  value.
- This is invariant **I1/I2** in [`SPEC.md`](SPEC.md) and is meant to be
  impossible; a counter-example is a serious bug.

## The one-line, zero-friction way

**Add the `spendguard-feedback` label** to an issue (or open one and apply
it). Maintainers watch that label. If you adopt spendguard on a team,
create that label once so everyone has a consistent path.

## The structured way

Open a **"spendguard report"** issue
(`.github/ISSUE_TEMPLATE/spend-feedback.yml`). It asks for the report type
(security / overspend-slipped / false-block / wrong-count / runaway / wrong
attribution), the upstream shape, and what happened in your own words.

## The verbatim guarantee

Whatever you write is **captured and read exactly as written** — no
summarization, no paraphrasing, no "cleaning up". Tuning a budget guard or
triaging a possible leak on second-hand paraphrases corrupts the signal, so
the raw text is the artifact. This mirrors the verbatim-at-capture contract
in [`src/feedback.js`](src/feedback.js) (tested in
`test/feedback.test.js`): append-only, order-preserving, and a single
corrupt record never drops the rest. `product` is recorded as `spendguard`.
`spendguard feedback "<text>"` writes one such record locally; opening the
labelled issue is what gets it to maintainers.

## What helps most

- **For a budget that didn't hold:** the budget/limit you configured, what
  `spendguard status` showed, and what was *still forwarded* past it. Note
  whether `--over-budget` was `hard-block` or `warn` (warn forwarding past
  budget is documented, intended behaviour — not a bug).
- **For a wrong count:** the upstream + endpoint shape (Anthropic
  `/v1/messages` streaming? an OpenAI-compatible `/v1/chat/completions`?),
  whether it was streamed, and the count you expected vs. what was
  recorded. Streamed-completion undercounts are especially valuable.
- **For wrong attribution:** how you tag projects (header value or
  one-guard-per-port) and which project the spend wrongly landed on.
- **For a runaway not killed / wrongly killed:** your `--max-calls` /
  `--window` and the rate you were calling at.
- Your invocation / version if non-default.

## What this tool is honest about up front

Before filing these as bugs — they are **documented, intended limitations**
(see the README "Honest limitations"), not defects:

- spendguard only sees traffic that goes **through** it. Spend that bypasses
  the proxy is invisible by design.
- The price table is **user-maintained**; the shipped numbers are coarse
  placeholders. "The cost is off because the default price is stale" → edit
  your `pricing` block.
- It is **not a billing system**; every figure is an estimate.
- Cost is known only after a call returns usage, so a project can overshoot
  by ~one in-flight call before the block engages (one-call granularity).

Reports about a budget *not holding when it should have*, a *leak*, or a
*token miscount* are the ones that move the needle.
