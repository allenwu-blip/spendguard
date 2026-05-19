/**
 * enforce.js — the preventive decision. PURE function: given the current
 * per-project ledger snapshot + the resolved config, decide whether the
 * NEXT call may be forwarded.
 *
 * This is the whole point of the product: the check happens BEFORE the
 * request is forwarded, not after the money is spent. Decisions:
 *
 *   ALLOW           forward upstream
 *   BLOCK_BUDGET    project is at/over its total or daily budget
 *   BLOCK_RUNAWAY   too many calls in the rolling window (loop kill)
 *   WARN            over budget but config says warn-only (still forwarded)
 *
 * Fail-safe direction is EXPLICIT and CONFIGURABLE:
 *   overBudget: "hard-block" (DEFAULT — the preventive whole point)
 *             | "warn"        (forward but flag; for users who want
 *                              observability without enforcement — they
 *                              opt in, it is loud, never the default)
 * The runaway-loop kill is independent and also hard by default; it exists
 * specifically for the "agent stuck in a loop burning tokens" case the
 * README cites, and it BLOCKS regardless of the budget setting unless
 * explicitly disabled (maxCallsPerWindow <= 0).
 *
 * `incomplete usage` handling: if a prior streamed call could not be
 * accounted (no usage in the stream), the recorded cost may UNDERSTATE
 * reality. The guard never *raises* a budget on uncertainty; it just keeps
 * enforcing on what it can see. The proxy separately surfaces the
 * incomplete-accounting condition (see proxy.js / README limitations).
 */

export const DECISION = {
  ALLOW: "ALLOW",
  WARN: "WARN",
  BLOCK_BUDGET: "BLOCK_BUDGET",
  BLOCK_RUNAWAY: "BLOCK_RUNAWAY",
};

/**
 * @param {{
 *   totalCost:number, dayCost:number, recentCount:number
 * }} snap  per-project snapshot from Ledger.snapshot()
 * @param {{
 *   budgetTotal:number|null,   // USD lifetime cap for this project (null = none)
 *   budgetDaily:number|null,   // USD per-UTC-day cap (null = none)
 *   overBudget:"hard-block"|"warn",
 *   maxCallsPerWindow:number,  // <=0 disables runaway kill
 *   windowMs:number
 * }} cfg
 * @returns {{decision:string, reason:string, limit:number|null, scope:string|null}}
 */
export function evaluate(snap, cfg) {
  const recentCount = Math.max(0, Number(snap.recentCount) || 0);
  const maxCalls = Number(cfg.maxCallsPerWindow);

  // 1) Runaway-loop kill FIRST. A stuck agent hammering the API is the
  //    acute failure mode; this fires even if a dollar budget is generous
  //    or unset. `recentCount` already excludes the current attempt until
  //    it is touched, so ">" means "this call would be the (max+1)-th".
  if (Number.isFinite(maxCalls) && maxCalls > 0 && recentCount >= maxCalls) {
    return {
      decision: DECISION.BLOCK_RUNAWAY,
      reason:
        `runaway-loop guard: ${recentCount} calls within the last ` +
        `${Math.round(cfg.windowMs / 1000)}s (limit ${maxCalls}). ` +
        `Likely a stuck agent loop — refusing to forward.`,
      limit: maxCalls,
      scope: "window",
    };
  }

  // 2) Dollar budgets. Daily evaluated before lifetime only for message
  //    clarity; either tripping blocks (or warns).
  const overDaily =
    cfg.budgetDaily != null && snap.dayCost >= cfg.budgetDaily;
  const overTotal =
    cfg.budgetTotal != null && snap.totalCost >= cfg.budgetTotal;

  if (overDaily || overTotal) {
    const scope = overDaily ? "daily" : "total";
    const limit = overDaily ? cfg.budgetDaily : cfg.budgetTotal;
    const spent = overDaily ? snap.dayCost : snap.totalCost;
    const base =
      `project is over its ${scope} budget: estimated $${fmt(spent)} ` +
      `>= $${fmt(limit)} cap`;
    if (cfg.overBudget === "warn") {
      return {
        decision: DECISION.WARN,
        reason:
          base +
          ` — over-budget policy is "warn", forwarding anyway (NOT enforced).`,
        limit,
        scope,
      };
    }
    return {
      decision: DECISION.BLOCK_BUDGET,
      reason:
        base +
        ` — over-budget policy is "hard-block", refusing to forward. ` +
        `(Spend is an ESTIMATE from your price table, not a bill.)`,
      limit,
      scope,
    };
  }

  return { decision: DECISION.ALLOW, reason: "within budget", limit: null, scope: null };
}

function fmt(x) {
  const v = Number(x) || 0;
  // up to 4 dp, trimmed — never scientific notation in a user-facing string
  return v.toFixed(4).replace(/\.?0+$/, "");
}
