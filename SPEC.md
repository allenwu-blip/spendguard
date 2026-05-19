# spendguard — SPEC

The single sharp axis: **preventively cap and attribute AI coding-agent
token spend per project, in the request path, without ever leaking the key
or prompt/response content.** Everything below is scoped to that. spendguard
is explicitly NOT a billing system, NOT a tokenizer, and NOT a secret
manager; the spec says so where it matters.

## 0. Security invariants (non-negotiable; tested)

These are properties, not features. Each maps to a test.

- **I1 — No key leak.** The upstream credential header
  (`authorization`/`x-api-key`/…) is forwarded byte-for-byte to the
  upstream and is *never* read, logged, persisted, or echoed in any
  diagnostic or error. (`src/redact.js` chokepoint; `test/no-leak.test.js`,
  `test/redact.test.js`.)
- **I2 — No content leak.** Request/response bodies are streamed through and
  scanned only for token-usage fields, then discarded. The ledger persists
  only `{project, model, tokenCounts, estCost, timestamps}`.
  (`src/ledger.js` fixed record shape; `test/no-leak.test.js` greps the
  persisted file + logs + stdout for sentinels.)
- **I3 — Localhost only.** A non-loopback bind is refused at config
  validation *and* again at listen time. (`src/config.js`, `src/proxy.js`
  `startProxy`; `test/config.test.js`, `test/proxy.test.js`.)
- **I4 — No silent overspend.** Over-budget default is hard-block; `warn`
  is opt-in and logged every time. Unknown config keys warn loudly (a
  typo'd budget key must not silently disable the budget).
  (`src/enforce.js`, `src/config.js`; `test/enforce.test.js`,
  `test/config.test.js`.)
- **I5 — No own LLM calls / no phone-home.** The only outbound socket is
  the pass-through to the user-configured upstream. (Whole design; the test
  suite uses a local fake upstream and no network.)

## 1. Inputs

- Subcommands: `start`, `status`, `pricing`, `feedback`.
- Flags: `--config`, `--port`, `--host`, `--upstream`, `--budget`,
  `--budget-total`, `--over-budget`, `--max-calls`, `--window`,
  `--project`, `--state-dir`, `--json`, `--quiet`, `-h/--help`,
  `-v/--version`.
- Config file: `./spendguard.config.json` or `~/.spendguard/config.json`,
  overridden by flags. Unknown keys → non-fatal warnings.
- Per-request: `x-spendguard-project: <tag>` header selects the project
  (else `defaultProject`).

## 2. Config resolution (`src/config.js`) — pure

`resolveConfig(raw) → {config, errors, warnings}`. Defaults frozen in
`DEFAULTS`. Validates and normalizes; **forces a loopback host** (rejects
anything else); `budget` shorthand maps to the *daily* cap; `port: 0` is
valid and means "OS-assigned ephemeral". Unknown top-level keys are
collected into `warnings` against a `KNOWN_KEYS` allow-list.

## 3. Pricing (`src/pricing.js`) — pure, user-maintained

`buildPricing(override)` merges a user table over coarse placeholder
defaults (USD per 1e6 tokens). `priceFor(table, model)` is **longest-prefix
match** with a mandatory `"*"` fallback so an unknown model is never
silently `$0` (silent-zero would defeat a budget guard). `estimateCost`
is `(in·inP + out·outP + cacheRead·crP + cacheWrite·cwP) / 1e6`;
cache prices default to the input price (conservative — never undercount).
`PRICING_DISCLAIMER` is asserted to contain "verify"/"estimate"/"does not
bill". No number is presented as an authoritative current vendor price.

## 4. Usage parsing (`src/usage.js`) — pure

- `parseNonStreaming(body)` — one JSON doc. Handles Anthropic
  (`usage.input_tokens/output_tokens/cache_*`) and OpenAI-compatible
  (`usage.prompt_tokens/completion_tokens`, `prompt_tokens_details.cached_tokens`).
  A 2xx with no readable usage → `incomplete:true` (never silent `$0`).
  Unparseable → `incomplete:true`, no throw.
- `StreamingUsageAccumulator` — fed raw SSE chunks; splits on event
  boundaries (`\n\n`/`\r\n\r\n`), keeps only the small unparsed tail,
  **never assembles or returns content**. Token fields are merged by
  `max()` across events: correct for Anthropic (cumulative `message_delta`
  output tokens) *and* OpenAI-compatible (single terminal usage chunk), and
  robust to duplicate/reordered events and TCP fragmentation. `end()` flags
  `incomplete:true` if no usage was ever seen.

## 5. Ledger (`src/ledger.js`)

Per-project: lifetime total, per-UTC-day totals, and a rolling array of
recent call timestamps (epoch ms only — no content) for runaway detection.
Fixed record shape (I2). `touch()` registers a call attempt for the runaway
window; `record()` books spend and **does not** touch the runaway window
(prevents double-counting — caught by TDD). Persistence is atomic
(`write tmp` `0o600` → `rename`); a corrupt state file does not crash and
never *raises* a budget. In-memory only when no `statePath`.

## 6. Enforcement (`src/enforce.js`) — pure

`evaluate(snapshot, cfg) → {decision, reason, limit, scope}` where decision
∈ `ALLOW | WARN | BLOCK_BUDGET | BLOCK_RUNAWAY`. Order:

1. **Runaway kill first** — `recentCount >= maxCallsPerWindow` (and
   `maxCallsPerWindow > 0`) → `BLOCK_RUNAWAY`, regardless of dollar budget.
2. **Dollar budget** — `dayCost >= budgetDaily` or `totalCost >=
   budgetTotal` → `BLOCK_BUDGET` (hard-block) or `WARN` (forward, flag
   loudly).
3. else `ALLOW`.

Decision is on spend **already accrued** (snapshot reflects prior calls,
not the current attempt). For a serialized agent the overshoot is therefore
≤ one call's worth. Under genuine concurrency the overshoot is bounded by
the number of simultaneously in-flight requests: each concurrent request
passes the pre-forward budget check before any completes and books spend, so
all are forwarded (see README limitations and the concurrency regression
test in `test/proxy.test.js`).

## 7. Proxy (`src/proxy.js`) — the impure server

- Buffers the request body (bytes only; content never inspected; 64 MiB
  DoS cap → 413).
- Computes the project tag (header, scrubbed defensively, else default).
- **Pre-forward gate:** `snapshot` → `evaluate`. On `BLOCK_*` the upstream
  is **never contacted**; agent gets a structured 429 whose message is
  scrubbed and carries a "this is an estimate, not a bill" note. On
  `ALLOW`/`WARN` it `touch()`es the runaway window then forwards.
- **Forward:** headers (incl. the credential) passed through untouched,
  `host` rewritten, body re-sent with a correct length. `joinUpstream`
  (pure, exported, tested) joins an upstream base path + the request
  path/query.
- **Response:** bytes streamed straight to the agent first; in parallel a
  usage accumulator (streaming) or a transient capped buffer
  (non-streaming) extracts usage, then the content is dropped.
- **§ordering (security-relevant):** spend is `account()`-ed (synchronous
  ledger update + atomic persist) **before** `res.end()` signals
  end-of-response to the agent. Otherwise a back-to-back next call could be
  budget-checked against a ledger that had not yet booked the call that
  just finished — overspend slipping the guard. This ordering is asserted
  by `test/proxy.test.js`.
- **incompleteUsage:** on an unaccountable stream the project is marked
  pending; `block-next` then refuses its next call (429
  `spendguard_incomplete_usage`) until restart/acknowledgement;
  `count-zero` (default) forwards but logs the gap.

## 8. CLI (`bin/spendguard.js`) — the impure shell

Arg parse, config file load + merge (CLI wins), state dir resolution.
`status` reads the ledger and prints human or `--json` (always with the
estimate disclaimer). `pricing` prints the table + disclaimer. `feedback`
appends verbatim. `start` runs the proxy and installs a SIGINT/SIGTERM
clean shutdown. The **only** diagnostic writer is `makeSafeLogger`, which
JSON-stringifies a strict key allow-list — even if the proxy ever passed
something unexpected, this final stage still cannot print a body/header.

## 9. Test discipline

`npm ci && npm test` (vitest). Every integration test spins a **local fake
upstream on 127.0.0.1** returning canned Anthropic/OpenAI-compatible
payloads incl. streaming. **No external network, no real key.** Coverage:
non-streaming + streaming accounting (both vendor shapes, incl. chunk-split
streams), per-project attribution, hard-budget block (upstream not
contacted on block), warn mode, runaway-loop kill, incomplete-usage
block-next, atomic persistence across restart, loopback-only refusal, and
`test/no-leak.test.js` (the I1/I2 proof: sentinels absent from logs/stdout/
persisted files while the key still reaches the upstream).

## 10. Non-goals (explicit)

Payments/billing/accounts (parked; an operator wires a Merchant-of-Record
tier separately — there is zero payment/money code here). Mid-request hard
ceilings. Tokenizing prompts. Secret management. CI emulation. Capturing
spend that bypasses the proxy.
