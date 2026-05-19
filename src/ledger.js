/**
 * ledger.js — per-project running spend.
 *
 * SECURITY-CRITICAL invariant: the ledger stores ONLY non-sensitive
 * accounting facts — project tag, model id, token counts, an estimated USD
 * cost, and timestamps. It NEVER stores prompt or response content, headers,
 * URLs with query strings, or anything resembling an API key. The record
 * shape is fixed in `record()` and the no-leak test asserts a persisted
 * ledger file never contains an injected sentinel key/prompt.
 *
 * Spend is tracked two ways simultaneously, both needed for enforcement:
 *  - per-project TOTAL (lifetime within this state file)
 *  - per-project per-DAY (UTC calendar day) for daily budgets
 * plus a short rolling window of recent call timestamps per project, used
 * by the runaway-loop detector (counts only — no content).
 *
 * Persistence is atomic (write temp + rename) so a crash mid-write cannot
 * corrupt the running total and let spend "reset" silently.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

function utcDay(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

const SCHEMA = 1;

export class Ledger {
  /**
   * @param {{statePath?:string, windowMs?:number}} [opts]
   *   statePath: file to persist to. If omitted, ledger is in-memory only
   *   (used by tests / ephemeral runs).
   */
  constructor(opts = {}) {
    this.statePath = opts.statePath || null;
    this.windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : 60_000;
    /** @type {{schema:number, projects:Record<string, any>}} */
    this.state = { schema: SCHEMA, projects: {} };
    if (this.statePath && existsSync(this.statePath)) this._load();
  }

  _load() {
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.projects) {
        this.state = { schema: SCHEMA, projects: parsed.projects };
      }
    } catch {
      // A corrupt state file must NOT crash the proxy and must NOT silently
      // zero a budget. Keep empty state but remember it so callers/tests can
      // see the load failed (treated as $0 known so the guard still blocks
      // once new spend accrues — it never *raises* a budget).
      this._loadError = true;
    }
  }

  _proj(project) {
    const key = project || "default";
    if (!this.state.projects[key]) {
      this.state.projects[key] = {
        totalCost: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        calls: 0,
        days: {}, // day -> {cost, inputTokens, outputTokens, calls}
        recent: [], // recent call epoch ms (for runaway detection) — no content
        lastModel: null,
      };
    }
    return this.state.projects[key];
  }

  /**
   * Record one accounted call. Only the fields below are ever stored.
   * @param {{project:string, model:string|null,
   *          inputTokens:number, outputTokens:number,
   *          cacheReadTokens?:number, cacheWriteTokens?:number,
   *          cost:number, ts?:number, incomplete?:boolean}} e
   */
  record(e) {
    const ts = Number.isFinite(e.ts) ? e.ts : Date.now();
    const day = utcDay(ts);
    const p = this._proj(e.project);
    const inT = Math.max(0, Number(e.inputTokens) || 0);
    const outT = Math.max(0, Number(e.outputTokens) || 0);
    const cost = Math.max(0, Number(e.cost) || 0);

    p.totalCost += cost;
    p.totalInputTokens += inT;
    p.totalOutputTokens += outT;
    p.calls += 1;
    p.lastModel = e.model || p.lastModel;

    const d = (p.days[day] ||= {
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
    });
    d.cost += cost;
    d.inputTokens += inT;
    d.outputTokens += outT;
    d.calls += 1;

    // NOTE: do NOT push to `recent` here. The runaway-loop window is driven
    // SOLELY by touch() (called once per forwarded attempt, pre-flight).
    // Pushing here too would double-count every successful call and make
    // the runaway kill fire at half the configured threshold. We still trim
    // defensively so the array stays bounded as time passes.
    this._trimRecent(p, ts);

    if (this.statePath) this._persist();
  }

  /** Register a call attempt timestamp WITHOUT cost (used to detect a
   * runaway loop even before the first usage comes back). No content. */
  touch(project, ts = Date.now()) {
    const p = this._proj(project);
    p.recent.push(ts);
    this._trimRecent(p, ts);
  }

  _trimRecent(p, now) {
    const cutoff = now - this.windowMs;
    // keep only timestamps within the window; cap array length defensively
    p.recent = p.recent.filter((t) => t >= cutoff);
    if (p.recent.length > 10_000) p.recent = p.recent.slice(-10_000);
  }

  /** @returns {{totalCost:number, dayCost:number, calls:number, dayCalls:number, recentCount:number}} */
  snapshot(project, now = Date.now()) {
    const p = this._proj(project);
    const day = utcDay(now);
    const d = p.days[day] || { cost: 0, calls: 0 };
    const cutoff = now - this.windowMs;
    const recentCount = p.recent.filter((t) => t >= cutoff).length;
    return {
      totalCost: p.totalCost,
      dayCost: d.cost,
      calls: p.calls,
      dayCalls: d.calls,
      recentCount,
    };
  }

  /** Full per-project summary for `spendguard status` (no content, ever). */
  summary(now = Date.now()) {
    const day = utcDay(now);
    const out = {};
    for (const [name, p] of Object.entries(this.state.projects)) {
      const d = p.days[day] || { cost: 0, inputTokens: 0, outputTokens: 0, calls: 0 };
      out[name] = {
        totalCost: round6(p.totalCost),
        totalInputTokens: p.totalInputTokens,
        totalOutputTokens: p.totalOutputTokens,
        totalCalls: p.calls,
        today: {
          day,
          cost: round6(d.cost),
          inputTokens: d.inputTokens,
          outputTokens: d.outputTokens,
          calls: d.calls,
        },
        lastModel: p.lastModel,
      };
    }
    return out;
  }

  _persist() {
    const dir = dirname(this.statePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // atomic: write to a unique temp then rename over the target.
    const tmp = join(
      dir,
      `.spendguard-${randomBytes(6).toString("hex")}.tmp`,
    );
    const payload = JSON.stringify({ schema: SCHEMA, projects: this.state.projects });
    writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.statePath);
  }
}

function round6(x) {
  return Math.round((Number(x) || 0) * 1e6) / 1e6;
}
