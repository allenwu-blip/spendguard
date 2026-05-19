#!/usr/bin/env node
/**
 * bin/spendguard.js — CLI entrypoint (Node >= 20, ZERO runtime deps).
 *
 * The impure shell lives here: arg parsing, reading the config file,
 * stdout, the long-running listen. The proxy, accounting, pricing and
 * enforcement are the pure/testable core in src/.
 *
 * SECURITY: this file's logger is the ONLY thing that writes proxy
 * diagnostics to stdout, and it ONLY ever prints objects the proxy already
 * shaped through src/redact.js (accounting facts: project, model, token
 * counts, est cost). It NEVER prints request/response bodies or the API
 * key — there is deliberately no flag to do so. The no-leak test injects a
 * sentinel key + prompt through a fake upstream and asserts neither appears
 * in this logger's output or any persisted file.
 *
 * Subcommands:
 *   start     run the guarding proxy (foreground; localhost only)
 *   status    print per-project spend (human or --json)
 *   pricing   print the (user-maintained) price table + the disclaimer
 *   feedback  append a verbatim feedback note (also: GitHub label/template)
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.js";
import { startProxy } from "../src/proxy.js";
import { Ledger } from "../src/ledger.js";
import {
  DEFAULT_PRICING,
  buildPricing,
  PRICING_DISCLAIMER,
} from "../src/pricing.js";
import { captureFeedback } from "../src/feedback.js";

const VERSION = "0.1.0";

const HELP = `spendguard ${VERSION} — a LOCAL proxy that PREVENTIVELY caps &
attributes AI coding-agent token spend per project.

USAGE
  spendguard start   [options]      run the guarding proxy (localhost only)
  spendguard status  [options]      per-project spend (estimate)
  spendguard pricing                print the user-maintained price table
  spendguard feedback "<text>"      record a verbatim note (see FEEDBACK.md)

POINT YOUR AGENT AT IT
  Start it, then set your agent's LLM base URL to http://127.0.0.1:<port>.
  spendguard forwards to the upstream you configure (--upstream), counts
  tokens from the API's OWN usage fields, and BLOCKS a project's calls once
  its budget is hit (default) instead of letting spend run away.

COMMON OPTIONS
  --config <file>        JSON config (default: ./spendguard.config.json or
                         ~/.spendguard/config.json if present)
  --port <n>             listen port (default 8787)
  --host <addr>          loopback only; non-loopback is REFUSED (default 127.0.0.1)
  --upstream <url>       upstream LLM base URL the proxy forwards to
                         (default https://api.anthropic.com). Any
                         OpenAI-compatible base URL also works — spendguard
                         is a pass-through; it makes NO LLM calls of its own.
  --budget <usd>         per-project per-DAY budget (USD estimate)
  --budget-total <usd>   per-project LIFETIME budget (USD estimate)
  --over-budget <mode>   hard-block (DEFAULT, prevents overspend) | warn
  --max-calls <n>        runaway-loop kill: block at >=n calls per window
                         (<=0 disables; default 60)
  --window <ms>          runaway window in ms (default 60000)
  --project <tag>        default project tag (per-request override:
                         x-spendguard-project header)
  --state-dir <dir>      where to persist the spend ledger
                         (default ~/.spendguard). Stores ONLY token counts,
                         model id, project tag, timestamps — NEVER content.
  --json                 (status) machine-readable output
  --quiet                (start) do not print the per-request accounting log
  -h, --help             this help
  -v, --version          print version

SECURITY POSTURE (read this — it sits in your API path)
  - It SEES your API key + prompt/response traffic because it forwards
    them. It NEVER logs, persists, transmits, or prints the key or the
    prompt/response bodies. The key flows in-memory to the upstream only.
  - NO telemetry, NO phone-home. The ONLY outbound connection is the
    pass-through to the upstream URL YOU configure. Binds localhost only.
  - Fail direction is explicit: over-budget => BLOCK by default (the whole
    point). \`--over-budget warn\` forwards anyway and says so loudly; it is
    opt-in and never silent.

NOT A BILLING SYSTEM
  Spend = tokens x YOUR price table. The shipped prices are coarse,
  user-maintained ESTIMATES — verify current vendor pricing and edit the
  \`pricing\` block in your config. spendguard estimates; it does not bill.
  It can only account for traffic that goes THROUGH it.`;

function parseArgs(argv) {
  const o = {
    cmd: null,
    config: null,
    port: undefined,
    host: undefined,
    upstream: undefined,
    budget: undefined,
    budgetTotal: undefined,
    overBudget: undefined,
    maxCalls: undefined,
    window: undefined,
    project: undefined,
    stateDir: undefined,
    json: false,
    quiet: false,
    help: false,
    version: false,
    text: null,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "-v" || a === "--version") o.version = true;
    else if (a === "--json") o.json = true;
    else if (a === "--quiet") o.quiet = true;
    else if (a === "--config") o.config = argv[++i];
    else if (a.startsWith("--config=")) o.config = a.slice(9);
    else if (a === "--port") o.port = argv[++i];
    else if (a.startsWith("--port=")) o.port = a.slice(7);
    else if (a === "--host") o.host = argv[++i];
    else if (a.startsWith("--host=")) o.host = a.slice(7);
    else if (a === "--upstream") o.upstream = argv[++i];
    else if (a.startsWith("--upstream=")) o.upstream = a.slice(11);
    else if (a === "--budget") o.budget = argv[++i];
    else if (a.startsWith("--budget=")) o.budget = a.slice(9);
    else if (a === "--budget-total") o.budgetTotal = argv[++i];
    else if (a.startsWith("--budget-total=")) o.budgetTotal = a.slice(15);
    else if (a === "--over-budget") o.overBudget = argv[++i];
    else if (a.startsWith("--over-budget=")) o.overBudget = a.slice(14);
    else if (a === "--max-calls") o.maxCalls = argv[++i];
    else if (a.startsWith("--max-calls=")) o.maxCalls = a.slice(12);
    else if (a === "--window") o.window = argv[++i];
    else if (a.startsWith("--window=")) o.window = a.slice(9);
    else if (a === "--project") o.project = argv[++i];
    else if (a.startsWith("--project=")) o.project = a.slice(10);
    else if (a === "--state-dir") o.stateDir = argv[++i];
    else if (a.startsWith("--state-dir=")) o.stateDir = a.slice(12);
    else if (a.startsWith("-") && a !== "-") return { error: `unknown option: ${a}` };
    else rest.push(a);
  }
  o.cmd = rest.shift() || null;
  if (o.cmd === "feedback") o.text = rest.join(" ");
  else if (rest.length) return { error: `unexpected extra argument: ${rest[0]}` };
  return { o };
}

function loadConfigFile(explicit) {
  const candidates = explicit
    ? [resolve(explicit)]
    : [
        resolve("spendguard.config.json"),
        join(homedir(), ".spendguard", "config.json"),
      ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return { raw: JSON.parse(readFileSync(p, "utf8")), path: p };
      } catch (e) {
        return { error: `cannot parse config ${p}: ${e.message}` };
      }
    }
  }
  return { raw: {}, path: null };
}

// Merge CLI flags over the file. CLI wins; undefined means "not given".
function mergeConfig(fileRaw, o) {
  const m = { ...fileRaw };
  if (o.port !== undefined) m.port = o.port;
  if (o.host !== undefined) m.host = o.host;
  if (o.upstream !== undefined) m.upstreamBaseUrl = o.upstream;
  if (o.budget !== undefined) m.budget = o.budget;
  if (o.budgetTotal !== undefined) m.budgetTotal = o.budgetTotal;
  if (o.overBudget !== undefined) m.overBudget = o.overBudget;
  if (o.maxCalls !== undefined) m.maxCallsPerWindow = o.maxCalls;
  if (o.window !== undefined) m.windowMs = o.window;
  if (o.project !== undefined) m.defaultProject = o.project;
  return m;
}

function stateDirOf(o, fileRaw) {
  const d = o.stateDir || fileRaw.stateDir || join(homedir(), ".spendguard");
  return resolve(d);
}

/**
 * The leak-safe stdout logger. It accepts ONLY the redact-shaped objects
 * the proxy emits. It JSON-stringifies a strict allow-list of keys so that
 * even if the proxy ever passed something unexpected, this final stage
 * still cannot print a body or a header value.
 */
function makeSafeLogger(out) {
  const ALLOW = new Set([
    "event",
    "method",
    "path",
    "project",
    "model",
    "bodyBytes",
    "respBytes",
    "streaming",
    "inputTokens",
    "outputTokens",
    "estCostUsd",
    "incompleteUsage",
    "decision",
    "detail", // proxy only ever passes already-scrubbed strings here
  ]);
  return (meta) => {
    if (!meta || typeof meta !== "object") return;
    const safe = {};
    for (const k of Object.keys(meta)) {
      if (ALLOW.has(k)) safe[k] = meta[k];
    }
    out(`spendguard ${JSON.stringify(safe)}`);
  };
}

async function run(argv, out, err) {
  const { o, error } = parseArgs(argv);
  if (error) {
    err(error + "\n\n" + HELP);
    return 2;
  }
  if (o.help || o.cmd === null) {
    out(HELP);
    return o.cmd === null && !o.help ? 2 : 0;
  }
  if (o.version) {
    out(VERSION);
    return 0;
  }

  if (o.cmd === "pricing") {
    const table = buildPricing(undefined);
    out("spendguard price table (USD per 1,000,000 tokens)");
    out("");
    out(PRICING_DISCLAIMER);
    out("");
    const rows = Object.entries(table)
      .map(([k, v]) => `  ${k.padEnd(22)} in=${v.input}  out=${v.output}`)
      .join("\n");
    out(rows);
    out("");
    out(
      'Edit the `pricing` block in your config to match what YOU pay. ' +
        'Unknown models fall back to the "*" row so spend is never silently $0.',
    );
    return 0;
  }

  const fc = loadConfigFile(o.config);
  if (fc.error) {
    err(`error: ${fc.error}\n`);
    return 2;
  }
  const stateDir = stateDirOf(o, fc.raw);
  const statePath = join(stateDir, "spend-state.json");

  if (o.cmd === "feedback") {
    if (!o.text || o.text.trim() === "") {
      err(
        'error: feedback text is required.\n' +
          '  spendguard feedback "budget did not hold: ..."\n' +
          "Zero-friction alternative: open a GitHub issue and add the " +
          "`spendguard-feedback` label (see FEEDBACK.md).\n",
      );
      return 2;
    }
    const sink = join(stateDir, "feedback.jsonl");
    // captureFeedback stores the text VERBATIM (no trim/normalize).
    captureFeedback(sink, { source: "cli", text: o.text });
    out(`recorded (verbatim) -> ${sink}`);
    out(
      "For maintainers to see it, also open a GitHub issue with the " +
        "`spendguard-feedback` label, or use the issue template. " +
        "Reports of a budget not holding — or any key/prompt leak — are " +
        "the highest-value input.",
    );
    return 0;
  }

  if (o.cmd === "status") {
    const ledger = new Ledger({ statePath });
    const summary = ledger.summary();
    if (o.json) {
      out(
        JSON.stringify(
          {
            tool: "spendguard",
            version: VERSION,
            stateFile: statePath,
            disclaimer:
              "Spend is an ESTIMATE from a user-maintained price table, " +
              "not a bill. Only traffic that went THROUGH the proxy is counted.",
            projects: summary,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    out(`spendguard status — ${statePath}`);
    out(
      "(estimate from your price table, NOT a bill; only proxied traffic counted)",
    );
    out("");
    const names = Object.keys(summary);
    if (names.length === 0) {
      out("  no spend recorded yet.");
      return 0;
    }
    for (const name of names) {
      const s = summary[name];
      out(`  project: ${name}`);
      out(
        `    total: ~$${s.totalCost}  (${s.totalInputTokens} in / ` +
          `${s.totalOutputTokens} out tokens, ${s.totalCalls} calls)`,
      );
      out(
        `    today (${s.today.day}): ~$${s.today.cost}  ` +
          `(${s.today.calls} calls)`,
      );
      out(`    last model: ${s.lastModel || "n/a"}`);
    }
    return 0;
  }

  if (o.cmd === "start") {
    const { config, errors, warnings } = resolveConfig(mergeConfig(fc.raw, o));
    if (errors.length) {
      err("error: invalid configuration:\n" + errors.map((e) => "  - " + e).join("\n") + "\n");
      return 2;
    }
    // Loudly surface unknown keys: a misnamed budget/limit key silently
    // unenforced is the exact failure this product must not have.
    for (const w of warnings || []) err(`warning: ${w}`);
    config.statePath = statePath;
    const logger = o.quiet ? () => {} : makeSafeLogger(out);
    let started;
    try {
      started = await startProxy(config, { log: logger });
    } catch (e) {
      err(`error: could not start proxy: ${e.message}\n`);
      return 2;
    }
    const addr = started.address;
    out(
      `spendguard ${VERSION} listening on http://${addr.address}:${addr.port}`,
    );
    out(`  forwarding to: ${config.upstreamBaseUrl}`);
    out(
      `  budget/project: ` +
        `${config.budgetDaily == null ? "none" : "$" + config.budgetDaily + "/day"}` +
        `${config.budgetTotal == null ? "" : ", $" + config.budgetTotal + " total"}` +
        `  over-budget: ${config.overBudget}`,
    );
    out(
      `  runaway kill: ${config.maxCallsPerWindow <= 0 ? "disabled" : config.maxCallsPerWindow + " calls / " + Math.round(config.windowMs / 1000) + "s"}`,
    );
    out(`  ledger: ${statePath} (token counts only — never content)`);
    out(
      `  point your agent's LLM base URL at http://${addr.address}:${addr.port}`,
    );
    out("  (Ctrl+C to stop. No telemetry. Localhost only.)");

    await new Promise((res) => {
      const shutdown = () => {
        out("\nspendguard stopping…");
        started.stop().then(res);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
    return 0;
  }

  err(`error: unknown command "${o.cmd}"\n\n` + HELP);
  return 2;
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("spendguard.js") ||
    process.argv[1].endsWith("spendguard"));
if (isMain) {
  run(
    process.argv.slice(2),
    (s) => process.stdout.write(s + "\n"),
    (s) => process.stderr.write(s + "\n"),
  ).then((code) => {
    process.exitCode = code;
  });
}

export { run, parseArgs, mergeConfig, makeSafeLogger };
