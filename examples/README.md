# Examples

spendguard is a developer CLI you run on your own machine. These are
copy-paste invocations and a sample config. **No invented vendor prices** —
the `pricing` block here is a placeholder you must verify and edit.

## The core loop: cap spend on a repo, preventively

```bash
# Start the guard in front of Anthropic, $10/day per project, hard-block
# (the default) so a runaway agent CANNOT blow the budget.
npx spendguard start \
  --upstream https://api.anthropic.com \
  --port 8787 \
  --budget 10

# Point Claude Code / the Anthropic SDK at it:
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
# (any OpenAI-compatible client: set its base URL to the same address)

# Tag this repo's spend (otherwise it lands under project "default").
# Most agents let you set a static header on outbound requests:
#   x-spendguard-project: my-repo
# Or run one guard per repo on different ports and skip the header.
```

## Observe, don't enforce (opt-in, never silent)

```bash
# Forward past budget but log a loud warning every time it's over.
npx spendguard start --upstream https://api.anthropic.com \
  --budget 10 --over-budget warn
```

## Kill stuck agent loops regardless of dollars

```bash
# Refuse a project's calls if it makes >30 in 60s (a likely runaway loop).
npx spendguard start --upstream https://api.anthropic.com \
  --max-calls 30 --window 60000
# Disable the runaway kill entirely with --max-calls 0.
```

## See attribution / spend (it's an estimate)

```bash
npx spendguard status            # per-project, human-readable
npx spendguard status --json     # machine-readable, with the disclaimer
npx spendguard pricing           # the user-maintained price table + caveat
```

## Leave feedback (stored verbatim)

```bash
npx spendguard feedback "budget didn't hold: set \$5/day on 'api', it forwarded past \$8"
# Then open a GitHub issue with the `spendguard-feedback` label so a
# maintainer sees it. See ../FEEDBACK.md.
```

## Sample config file

Save as `spendguard.config.json` (CLI flags override it). See
[`spendguard.config.example.json`](spendguard.config.example.json). The
prices below are **placeholders** — verify current vendor pricing and
replace them with what *you* pay.
