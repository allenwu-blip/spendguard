/**
 * pricing.js — the user-maintained model -> price table.
 *
 * IMPORTANT (stated loudly in the README too): these defaults are a
 * STARTING POINT for ESTIMATION, not an authoritative price feed. Vendor
 * pricing changes; tiers, caching, batch discounts, and per-region prices
 * are NOT modeled. spendguard does NOT bill anyone. The user is expected to
 * edit this table (via the config file's `pricing` block) to match the
 * pricing THEY actually pay. spend = tokens x (this table) and is always an
 * estimate.
 *
 * Numbers below are expressed as USD per 1,000,000 tokens. They are
 * intentionally round, conservative placeholders chosen so the tool is
 * usable out of the box — they are NOT presented as the current correct
 * vendor price and the CLI/README repeatedly say "verify current vendor
 * pricing". A `*` family fallback lets unknown model ids still be counted
 * rather than silently costing $0 (silent $0 would defeat a budget guard).
 */

export const PRICING_DISCLAIMER =
  "Prices are user-maintained ESTIMATES (USD per 1M tokens), not a live " +
  "vendor feed. Verify current vendor pricing and edit the `pricing` block " +
  "in your config. spendguard estimates spend; it does not bill.";

/**
 * Default table. Keyed by a lowercased model-id PREFIX. Lookup picks the
 * longest matching prefix. `input`/`output` are USD per 1,000,000 tokens.
 * `cacheRead`/`cacheWrite` are optional; when a usage payload reports them
 * and no override is given they fall back to input price (conservative —
 * never undercount).
 *
 * These are deliberately coarse buckets, not a claim about any specific
 * current price. Edit to match what you pay.
 */
export const DEFAULT_PRICING = {
  // Anthropic Claude families (coarse buckets — verify & edit).
  "claude-3-opus": { input: 15, output: 75 },
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-3-7-sonnet": { input: 3, output: 15 },
  "claude-sonnet": { input: 3, output: 15 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-3-haiku": { input: 0.25, output: 1.25 },
  "claude-haiku": { input: 0.8, output: 4 },
  "claude-opus": { input: 15, output: 75 },
  "claude-": { input: 3, output: 15 },
  // OpenAI-compatible families (coarse buckets — verify & edit).
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "gpt-4": { input: 30, output: 60 },
  "gpt-3.5": { input: 0.5, output: 1.5 },
  "o1-mini": { input: 1.1, output: 4.4 },
  "o1": { input: 15, output: 60 },
  "o3-mini": { input: 1.1, output: 4.4 },
  // Last-resort fallback so an unrecognised model is still COUNTED (a
  // budget guard that silently treats unknown models as free is unsafe).
  // Picked to be non-trivial on purpose.
  "*": { input: 5, output: 15 },
};

/**
 * Merge a user `pricing` override on top of the defaults. The override is a
 * plain object of the same shape. Unknown keys are kept; this lets a user
 * add a model the defaults never heard of.
 *
 * @param {Record<string, object>|undefined} override
 * @returns {Record<string, {input:number,output:number,cacheRead?:number,cacheWrite?:number}>}
 */
export function buildPricing(override) {
  const table = { ...DEFAULT_PRICING };
  if (override && typeof override === "object") {
    for (const [k, v] of Object.entries(override)) {
      if (!v || typeof v !== "object") continue;
      const key = String(k).toLowerCase();
      const prev = table[key] || {};
      const next = { ...prev };
      for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
        if (typeof v[field] === "number" && Number.isFinite(v[field]) && v[field] >= 0) {
          next[field] = v[field];
        }
      }
      if (typeof next.input === "number" || typeof next.output === "number") {
        table[key] = next;
      }
    }
  }
  return table;
}

/**
 * Resolve the price entry for a model id by longest-prefix match. Always
 * returns SOMETHING (falls back to "*") so spend is never silently zero.
 *
 * @param {Record<string,object>} table
 * @param {string} model
 * @returns {{input:number,output:number,cacheRead?:number,cacheWrite?:number, matched:string}}
 */
export function priceFor(table, model) {
  const m = String(model || "").toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const key of Object.keys(table)) {
    if (key === "*") continue;
    if (m.startsWith(key) && key.length > bestLen) {
      best = key;
      bestLen = key.length;
    }
  }
  if (best == null) {
    const star = table["*"] || DEFAULT_PRICING["*"];
    return { ...star, matched: "*" };
  }
  return { ...table[best], matched: best };
}

/**
 * Estimate USD cost for one accounted call. Pure function of token counts
 * and the resolved price entry. cacheRead/cacheWrite default to the input
 * price when not separately priced (conservative: never undercount).
 *
 * @param {{input:number,output:number,cacheRead?:number,cacheWrite?:number}} price
 * @param {{inputTokens?:number,outputTokens?:number,cacheReadTokens?:number,cacheWriteTokens?:number}} usage
 * @returns {number} USD estimate (full precision; round only for display)
 */
export function estimateCost(price, usage) {
  const inT = num(usage.inputTokens);
  const outT = num(usage.outputTokens);
  const crT = num(usage.cacheReadTokens);
  const cwT = num(usage.cacheWriteTokens);
  const inP = num(price.input);
  const outP = num(price.output);
  const crP = typeof price.cacheRead === "number" ? price.cacheRead : inP;
  const cwP = typeof price.cacheWrite === "number" ? price.cacheWrite : inP;
  const per = 1_000_000;
  return (
    (inT * inP) / per +
    (outT * outP) / per +
    (crT * crP) / per +
    (cwT * cwP) / per
  );
}

function num(x) {
  return Number.isFinite(x) && x > 0 ? x : 0;
}
