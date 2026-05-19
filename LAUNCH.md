# LAUNCH — agent-spend-guard (spendguard)

**DRAFT — operator reviews and posts. Public technical claims are yours to send.**
All claims below are drawn from the reviewed README only. The external spend
figures ($200-500/month, morphllm.com reference) are from cited sources in the
README — attribute them correctly. Do not add benchmark figures not already there.

---

## Show HN title

```
Show HN: spendguard – local proxy that hard-blocks AI agent API calls when a project budget is hit
```

## Show HN body

```
AI coding agents billed against a pay-per-use AI API can run away with your
money. The existing tools show you usage after the fact — the bill already
happened.

spendguard is a prepaid meter for that spend. It sits between your agent and
the AI provider: point your agent at it, it passes calls through to the real
provider, tallies spend per project, and — the moment a project hits its
budget — refuses to forward the next call and returns an "over budget" message
to the agent instead. The money is never spent in the first place.

npx spendguard start --upstream https://api.anthropic.com --budget 10
# then set your agent's LLM base URL to the printed http://127.0.0.1:8787

Security posture, because this sits in your request path and sees your key:
spendguard never logs, persists, transmits, or prints your API key or
prompt/response bodies. Keys are copied in-memory onto the upstream request
and are never stored or echoed. Responses are scanned only for the API's own
token-usage fields, then discarded. The spend ledger stores: project tag,
model, token counts, estimated cost, timestamps — never content. There is
deliberately no debug flag that dumps bodies.

It binds loopback only (a non-loopback --host is refused). These guarantees are
not just prose — test/no-leak.test.js drives real non-streaming, streaming, and
blocked traffic and asserts the sentinel key and prompt are absent from every log,
ledger, and stdout line, while asserting the key was still delivered upstream.

This is an estimate, not a billing system. The price table is coarse
user-maintained placeholders — verify your vendor's current pricing and edit
the config.

67 tests green from a clean install. No LLM. No telemetry. No phone-home. MIT.

GitHub: [link]
```

---

## One-paragraph repo description

```
spendguard is a local proxy that preventively caps and attributes AI coding-agent
token spend per project. Point your agent's LLM base URL at localhost; spendguard
forwards to your real upstream, counts tokens per project, enforces a hard
per-project budget, and kills runaway loops by returning an over-budget error
instead of forwarding. It never logs, persists, or echoes your API key or
prompt/response bodies; binds loopback only; and hard-blocks by default. Spend
numbers are estimates — verify your vendor's pricing. No LLM, no telemetry.
MIT license.
```

---

## Honest 2-3 line blurb
(For a pinned issue or README TL;DR)

```
spendguard is an estimate, not a billing system. The shipped price table is a set
of coarse placeholder estimates — not a live vendor price feed. It does not process
payments. Treat every number it prints as an estimate and verify current pricing
with your LLM vendor.
```

---

## Notes for operator before posting

- Replace `<owner>` and `[link]` placeholders with real values once the repo is public.
- The $200-500/month and morphllm.com figures are from the cited external sources
  in the README. Use them with attribution in discussion replies; do not present
  them as claims about spendguard's measured savings.
- If published to npm before posting, substitute the real `npx spendguard` invocation.
- A terminal screenshot of `spendguard start` output and a sample over-budget block
  response is the most useful visual to add before posting.
