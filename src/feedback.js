/**
 * feedback.js — verbatim feedback collector.
 *
 * Mirrors the operation's reusable feedback pattern: a developer's report
 * (e.g. "spendguard kept forwarding past my $5/day cap", or — most serious —
 * "I saw something key-shaped in a log line") is stored EXACTLY as written —
 * no strip, no normalize, no summarization. Tuning a budget guard / triaging
 * a possible leak on paraphrased reports corrupts the signal, so the raw
 * text IS the artifact.
 *
 * Intentionally tiny and dependency-free. The free CLI's primary feedback
 * channel is the `spendguard-feedback` issue label + the issue template
 * (see FEEDBACK.md); this module is the same contract in code for local
 * notes and a future hosted aggregation tier. NO network, NO accounts, NO
 * payment code. It records ONLY what the reporter typed plus a timestamp —
 * never proxied traffic.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";

/**
 * Append one verbatim feedback record as a single JSON line. `text` is
 * written EXACTLY as given (no .trim(), no normalization).
 *
 * @param {string} sink path to the .jsonl feedback log
 * @param {{source:string, text:string, extra?:object}} rec
 */
export function captureFeedback(sink, { source, text, extra }) {
  const record = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    product: "spendguard",
    source,
    text, // verbatim — do not transform
    extra: extra || {},
  };
  appendFileSync(sink, JSON.stringify(record) + "\n", "utf8");
}

/**
 * Read records grouped by source, preserving order and exact text. A single
 * corrupt line is skipped — it never aborts the read.
 *
 * @param {string} sink
 * @returns {Record<string, Array<object>>}
 */
export function loadFeedback(sink) {
  /** @type {Record<string, Array<object>>} */
  const out = {};
  if (!existsSync(sink)) return out;
  const raw = readFileSync(sink, "utf8");
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // skip one corrupt record; never abort
    }
    const key = rec.source || "unknown";
    (out[key] ||= []).push(rec);
  }
  return out;
}
