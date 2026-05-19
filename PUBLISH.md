# PUBLISH — agent-spend-guard / spendguard (Allen-only owner gates)

Built & independently reviewed: real Node 20 CLI proxy, 67 tests green from a clean install (including a dedicated no-leak test that injects sentinel keys/prompts and asserts they never appear in logs, ledger, or stdout), loopback-only bind enforced in code, hard-block default, no LLM, no telemetry, no phone-home. **AI never does the steps below — they are identity/publish, only you.**

## Gate 1 — Publish the free CLI (drives adoption; $0 cost)

1. Create a **public GitHub repo** under your account/org (e.g. `<owner>/spendguard`).
2. In `products/agent-spend-guard/package.json`: set `"private": false` (required before `npm publish`; the `npx` path works regardless, but the registry refuses while private).
3. Replace every `<OWNER>` placeholder in `README.md` with your real GitHub owner handle.
4. Push the `products/agent-spend-guard/` contents to that repo root; tag a release (`v0` + a SHA-pinned tag); create a GitHub Release.
5. Create label **`spendguard-feedback`** in that repo (the primary channel where real user reports come in, stored word-for-word, for this bet).
6. Publish to npm for true `npx spendguard` support: `npm publish --access public`.

→ After this, developers can `npx spendguard start --upstream https://api.anthropic.com --budget 10` and point agents at the printed localhost URL. **This is the real signal start.**

### No GitHub Action for this product

spendguard has no `action.yml` — it is a CLI proxy, not a CI step. The GitHub Marketplace step does not apply. Skip it.

### npm name availability note

The package is published as `spendguard`. Verify availability at <https://www.npmjs.com/package/spendguard> before publishing. If taken, fall back to a scoped name: update `"name"` in package.json to `"@<owner>/spendguard"` and `npm publish --access public` — then users run `npx @<owner>/spendguard`.

## Gate 2 — payment account (only if/when monetizing; the revenue gate)

**Free launch needs ZERO payment setup.** The free CLI collects $0 by design. A paid tier (hosted budget management, team dashboards) would need a **merchant-of-record account in your name** (MoR — a service like Paddle / Lemon Squeezy / Polar that sells on your behalf and handles tax). No payment code exists in this product — that is a deliberate later layer.

## Budget note

Free CLI = no hosting cost. Any paid hosted tier = real spend; ratify before committing.

## What stays automated (not you)

Building, tests, reviews, feedback collection — all AI, feedback-paced. You: the gates above + reading RATIFY packets + pressing KILL/SCALE.
