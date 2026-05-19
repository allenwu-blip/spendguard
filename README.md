# spendguard

**A prepaid meter for what your AI coding agent spends — it cuts the call off
before the money is gone, not after.**

AI coding agents bill against a per-use API and can quietly run up a large
bill, especially if one gets stuck in a loop. spendguard sits between your
agent and the AI provider: you point the agent at it, it passes calls through
to the real provider, tallies the spend per project, and the moment a project
hits the budget you set it **refuses to forward the next call** and returns a
clear "over budget" message to the agent instead. The money is never spent in
the first place — like a prepaid meter that just stops, rather than a bill that
arrives later. It also cuts off an agent stuck in a runaway loop.

```bash
npx spendguard start --upstream https://api.anthropic.com --budget 10
# then set your agent's LLM base URL to the printed http://127.0.0.1:8787
```

---

## ⚠️ Read this first — what it can see, and what it does with it

To *stop* overspending (not just report it after the fact), spendguard has to
sit directly in the path of your AI API calls. That means it unavoidably
*sees* your API key and the prompts and responses going by. Here is exactly
what it does and does not do with that — enforced in code and checked by the
test suite:

- **It NEVER logs, persists, transmits, or prints your API key or your
  prompt/response bodies.** The key is copied straight onto the upstream
  request in-memory and is never read, stored, or echoed. Request/response
  bodies are streamed through and scanned **only** for the API's own
  token-usage numbers, then discarded. The spend ledger stores **only**:
  project tag, model id, token counts, an estimated USD cost, timestamps —
  never content. There is deliberately **no debug flag that dumps bodies**.
- **No telemetry. No phone-home.** The *only* outbound network connection
  spendguard makes is the pass-through to the upstream URL **you**
  configure. It **binds a loopback address only** — a non-loopback `--host`
  is *refused* (a process holding your API key must not be reachable
  off-box), and that refusal is enforced twice (config validation + at
  listen time), not just documented.
- **The fail-safe direction is explicit and configurable.** Default
  behaviour when a project is over budget is **hard-block** (refuse to
  forward — prevention is the entire point). `--over-budget warn` will
  forward anyway, but it is **opt-in, logged loudly every time, and never
  silent**. spendguard will never quietly allow overspend while claiming to
  guard.

This is verified by `test/no-leak.test.js`, which injects a sentinel API
key (in `Authorization` + `x-api-key`) and a sentinel prompt/response,
drives real non-streaming, streaming, *and* blocked traffic through the
proxy, then asserts the sentinels are **absent** from every log line, the
CLI's stdout, the persisted ledger file, and any other persisted file —
**while simultaneously asserting the key WAS delivered to the upstream**
(passthrough has to keep working; a proxy that drops your key is useless).

## ⚠️ This is an estimate, not a billing system

spendguard does **not** process payments and is **not** a billing system.
It estimates spend as **`tokens × your price table`**. The shipped price
table is a set of **coarse, user-maintained placeholder estimates** — they
are *not* an authoritative or live vendor price feed, and they are
intentionally round numbers, not a claim about any vendor's current price.
**Verify current vendor pricing and edit the `pricing` block in your
config** to match what *you* actually pay (tiered/cached/batch/region
pricing is not modeled). Treat every number spendguard prints as an
estimate.

---

## Why this exists

Developers running AI coding agents against a pay-per-use AI API routinely
spend **$200–500/month**, with heavy users higher; one widely-cited write-up
puts an 8-month Claude Code log at roughly **10 billion tokens /
~$15k-equivalent**
([morphllm.com/ai-coding-costs](https://www.morphllm.com/ai-coding-costs)),
and Cursor publicly issued refunds after a usage-overage backlash. The
existing tools (e.g. `ccusage`) show you usage **after the fact** — the bill
has already happened.

What's missing is a thin control that *prevents* it: enforce a hard budget
per project *before* the call goes out, track which project spent what, and
cut off an agent stuck in a loop on the API. spendguard is that, and only
that.

## How it works

```
your agent  ──HTTP──▶  127.0.0.1:PORT (spendguard)  ──▶  your upstream LLM API
                              │
                    1. tag the request to a project
                       (x-spendguard-project header, else default)
                    2. BEFORE forwarding: check the per-project ledger
                       → over budget?  → 429 over-budget error (NOT forwarded)
                       → runaway loop? → 429 runaway error    (NOT forwarded)
                    3. otherwise forward; stream the response straight back
                    4. scan the response for the API's own token usage,
                       discard the content, record tokens+model+cost
                       to the per-project ledger (atomic, content-free)
```

- **Streaming is accounted correctly.** For SSE responses the accumulator
  tracks the *final/most-complete* usage (Anthropic's cumulative
  `message_delta` output tokens; OpenAI-compatible's terminal usage chunk),
  surviving arbitrary TCP chunk boundaries — it does **not** undercount a
  streamed completion. If an OpenAI-compatible stream carries *no* usage
  (caller didn't request `stream_options.include_usage`), spendguard marks
  the call **incomplete** rather than silently recording `$0`; the
  `incompleteUsage` policy decides whether to keep going (`count-zero`,
  default, logs the gap) or to block the project's next call until usage is
  visible again (`block-next`).
- **Per-project attribution.** The project is the value of the
  `x-spendguard-project` request header, or the configured default. Each
  project has its own running total, its own per-UTC-day total, and its own
  budget enforcement.
- **Runaway-loop kill.** Independent of the dollar budget: if a project
  makes ≥ `maxCallsPerWindow` calls within `windowMs`, further calls are
  refused with a runaway error. This is the "agent stuck in a loop burning
  tokens" guard and is on by default (set `--max-calls 0` to disable).

## Install / usage

Zero runtime dependencies, Node ≥ 20.

```bash
# Start the guard (foreground). --upstream is whatever LLM API you use.
npx spendguard start \
  --upstream https://api.anthropic.com \
  --port 8787 \
  --budget 10 \                 # USD/project/day (estimate)
  --over-budget hard-block      # default; or 'warn'

# Point your agent at it. For Claude Code / Anthropic SDK:
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
# For an OpenAI-compatible client: set its base URL to the same.

# Tag a project (otherwise everything is project "default"):
#   send header  x-spendguard-project: my-repo
# (most agents let you add a static header; or run one guard per repo on
#  different ports.)

# See per-project spend (estimate):
npx spendguard status
npx spendguard status --json

# Print the (user-maintained) price table + the disclaimer:
npx spendguard pricing

# Leave feedback (stored verbatim — see FEEDBACK.md):
npx spendguard feedback "budget didn't hold on project X: ..."
```

### Config file

`spendguard.config.json` in the working directory (or
`~/.spendguard/config.json`), overridden by CLI flags:

```json
{
  "upstreamBaseUrl": "https://api.anthropic.com",
  "port": 8787,
  "budgetDaily": 10,
  "budgetTotal": 200,
  "overBudget": "hard-block",
  "maxCallsPerWindow": 60,
  "windowMs": 60000,
  "incompleteUsage": "count-zero",
  "pricing": {
    "claude-3-5-sonnet": { "input": 3, "output": 15 },
    "my-self-hosted-model": { "input": 0, "output": 0 }
  }
}
```

A **misspelled or unknown config key is reported as a loud warning** (not
silently ignored) — a budget/limit that is silently unenforced because of a
typo is exactly the failure this tool exists to prevent.

## Honest limitations

spendguard is a sharp, single-purpose preventive control. It is **not**:

- **A billing system.** Spend is `tokens × your price table` — an estimate.
  Real invoices include pricing tiers, prompt caching, batch discounts and
  per-region prices that spendguard does not model. The shipped prices are
  user-maintained placeholders; **verify and edit them**.
- **Able to see spend that bypasses the proxy.** It only accounts for
  traffic that actually goes *through* it. If your agent (or another tool)
  talks to the LLM API directly, that spend is invisible to spendguard. The
  budget is only as good as "everything is pointed at the proxy".
- **A guarantee you cannot exceed a number by a cent.** Token cost is only
  known *after* a call returns its usage. spendguard blocks the *next* call
  once a project has *already* accrued ≥ its budget — so the project can
  overshoot before the block engages. The overshoot is bounded by the number
  of **in-flight** requests at the moment the budget is crossed: each
  concurrent request passes the pre-forward budget check before any of them
  completes and books spend, so all of them are forwarded (repro: N
  simultaneous requests vs a budget allowing K → all N forwarded). For an
  agent that **serializes** its requests (the dominant coding-agent pattern),
  the overshoot is ≤ one call's worth. It is a preventive cap, not a hard
  ceiling enforced mid-request. (Back-to-back calls do **not** slip the
  guard: spend is booked before the response completes to the agent — see
  `test/proxy.test.js` and `SPEC.md` §ordering.)
- **A tokenizer.** It reads the API's *own* reported usage; it does not
  re-tokenize your prompt. If an upstream returns a 2xx with no usage
  spendguard can parse, that call is flagged `incomplete` (and per policy
  may block subsequent calls) rather than counted as free.
- **An auth/secret manager.** It forwards whatever credential header your
  agent already sends. It never stores or manages keys.

If spendguard's accounting is wrong, or a budget did not hold, or — most
serious — you ever see anything key- or prompt-shaped in a log or file,
that is the single most valuable thing you can report. See
[`FEEDBACK.md`](FEEDBACK.md).

## A note on upstreams (Anthropic / OpenAI-compatible)

spendguard makes **zero LLM calls of its own** — it is a pure pass-through.
It must faithfully proxy whatever upstream **you** configure, including
OpenAI-compatible endpoints; supporting them as a proxy *target* is correct
infrastructure behaviour, not a product opinion about which model to use.

## Development

```bash
npm ci
npm test     # vitest; spins a LOCAL fake upstream on 127.0.0.1.
             # NO external network, NO real API key. Includes the
             # no-key/no-prompt-leak assertion.
```

## License

MIT — see [LICENSE](LICENSE). Faceless project; contributions welcome via
issues/PRs.
