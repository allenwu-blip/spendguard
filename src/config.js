/**
 * config.js — resolve spendguard configuration. PURE: takes a raw object
 * (parsed from a config file and/or CLI flags) and returns a normalised,
 * validated config with safe defaults. No I/O here (the CLI reads the file
 * and passes the object in) so this is fully unit-testable.
 *
 * Security defaults that are NOT negotiable in code:
 *   - host is forced to a loopback address. A non-loopback host is REJECTED
 *     (a token-spend proxy that holds your API key must never bind a public
 *     interface). This is enforced here, not just documented.
 *   - over-budget default is "hard-block" (prevention is the point).
 *
 * Budgets: `budget` is a convenience that sets the DAILY cap by default
 * (the common ask is "max $X per project per day"); `budgetTotal` sets a
 * lifetime cap. Either/both may be null (no cap on that axis). A project
 * with no configured budget is still accounted and still loop-guarded.
 */

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export const DEFAULTS = Object.freeze({
  host: "127.0.0.1",
  port: 8787,
  upstreamBaseUrl: "https://api.anthropic.com",
  // null => no cap on that axis (still accounted; still loop-guarded)
  budgetDaily: null,
  budgetTotal: null,
  overBudget: "hard-block", // "hard-block" | "warn"
  maxCallsPerWindow: 60, // runaway-loop kill: >=N calls within windowMs
  windowMs: 60_000,
  // how to attribute spend to a project:
  //  - explicit header `x-spendguard-project: <tag>` always wins
  //  - else the configured default tag
  projectHeader: "x-spendguard-project",
  defaultProject: "default",
  // requestTimeoutMs guards the upstream call so a hung upstream cannot
  // pin the proxy open forever.
  requestTimeoutMs: 600_000,
});

/**
 * @param {object} raw merged config (file overlaid by CLI flags)
 * @returns {{config:object, errors:string[]}}
 */
export function resolveConfig(raw = {}) {
  const errors = [];
  const c = { ...DEFAULTS };

  // --- host: loopback ONLY, enforced ---
  if (raw.host != null) {
    const h = String(raw.host).trim();
    if (!LOOPBACK.has(h)) {
      errors.push(
        `host "${h}" is not a loopback address. spendguard holds your ` +
          `upstream API key and MUST bind localhost only — refusing to ` +
          `bind a non-loopback interface. Use 127.0.0.1 / ::1 / localhost.`,
      );
    } else {
      c.host = h === "localhost" ? "127.0.0.1" : h;
    }
  }

  if (raw.port != null) {
    const p = Number(raw.port);
    // 0 is valid and means "let the OS pick a free ephemeral port" (useful
    // for running several guards, or scripted/ephemeral use). 1..65535 are
    // explicit ports. Anything else is rejected.
    if (!Number.isInteger(p) || p < 0 || p > 65535) {
      errors.push(`port must be an integer 0..65535 (0 = ephemeral) (got ${raw.port})`);
    } else {
      c.port = p;
    }
  }

  if (raw.upstreamBaseUrl != null || raw.upstream != null) {
    const u = String(raw.upstreamBaseUrl ?? raw.upstream).trim();
    let parsed;
    try {
      parsed = new URL(u);
    } catch {
      parsed = null;
    }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
      errors.push(
        `upstreamBaseUrl must be a valid http(s) URL (got "${u}")`,
      );
    } else {
      // strip trailing slash; path is preserved (some gateways live under
      // a base path).
      c.upstreamBaseUrl = u.replace(/\/+$/, "");
    }
  }

  // budgets. `budget` (shorthand) -> daily unless budgetDaily given.
  const dailyRaw =
    raw.budgetDaily != null ? raw.budgetDaily : raw.budget;
  c.budgetDaily = normBudget(dailyRaw, "budgetDaily", errors);
  c.budgetTotal = normBudget(raw.budgetTotal, "budgetTotal", errors);

  if (raw.overBudget != null) {
    const ob = String(raw.overBudget).trim();
    if (ob !== "hard-block" && ob !== "warn") {
      errors.push(
        `overBudget must be "hard-block" or "warn" (got "${ob}")`,
      );
    } else {
      c.overBudget = ob;
    }
  }

  if (raw.maxCallsPerWindow != null) {
    const m = Number(raw.maxCallsPerWindow);
    if (!Number.isFinite(m)) {
      errors.push(`maxCallsPerWindow must be a number (got ${raw.maxCallsPerWindow})`);
    } else {
      c.maxCallsPerWindow = m; // <=0 disables the runaway kill (documented)
    }
  }

  if (raw.windowMs != null) {
    const w = Number(raw.windowMs);
    if (!Number.isFinite(w) || w <= 0) {
      errors.push(`windowMs must be a positive number (got ${raw.windowMs})`);
    } else {
      c.windowMs = w;
    }
  }

  if (raw.requestTimeoutMs != null) {
    const t = Number(raw.requestTimeoutMs);
    if (!Number.isFinite(t) || t <= 0) {
      errors.push(`requestTimeoutMs must be a positive number (got ${raw.requestTimeoutMs})`);
    } else {
      c.requestTimeoutMs = t;
    }
  }

  if (raw.projectHeader != null) {
    c.projectHeader = String(raw.projectHeader).trim().toLowerCase() || DEFAULTS.projectHeader;
  }
  if (raw.defaultProject != null) {
    c.defaultProject = String(raw.defaultProject).trim() || DEFAULTS.defaultProject;
  }

  // pricing override is passed through untouched (validated in pricing.js).
  if (raw.pricing && typeof raw.pricing === "object") {
    c.pricing = raw.pricing;
  }

  // incompleteUsage policy: what to do when a streamed response carried no
  // usage we could read. "count-zero" (default; record $0 but flag) keeps
  // the proxy transparent; "block-next" makes the guard conservative by
  // blocking the project's next call until usage is observed again.
  c.incompleteUsage =
    raw.incompleteUsage === "block-next" ? "block-next" : "count-zero";

  // Surface UNKNOWN config keys as warnings. A spend guard that silently
  // ignores a misspelled `maxCalls` (vs `maxCallsPerWindow`) would fail
  // open without the user knowing — exactly the failure mode this product
  // exists to prevent. We warn (non-fatal) rather than hard-error so a
  // forward-compatible config from a newer version still runs.
  const warnings = [];
  for (const k of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(k)) {
      warnings.push(
        `unknown config key "${k}" ignored — check spelling (e.g. ` +
          `maxCallsPerWindow, budgetTotal). A misnamed budget/limit key ` +
          `means it is NOT enforced.`,
      );
    }
  }

  return { config: c, errors, warnings };
}

// Every accepted top-level config key (file or merged CLI). Used to detect
// typos that would otherwise silently disable a budget/limit.
const KNOWN_KEYS = new Set([
  "host",
  "port",
  "upstreamBaseUrl",
  "upstream",
  "budget",
  "budgetDaily",
  "budgetTotal",
  "overBudget",
  "maxCallsPerWindow",
  "windowMs",
  "requestTimeoutMs",
  "projectHeader",
  "defaultProject",
  "pricing",
  "incompleteUsage",
  "stateDir",
]);

function normBudget(v, name, errors) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    errors.push(`${name} must be a non-negative number of USD (got ${v})`);
    return null;
  }
  return n;
}

export { LOOPBACK };
