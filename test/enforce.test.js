import { describe, it, expect } from "vitest";
import { evaluate, DECISION } from "../src/enforce.js";

const base = {
  budgetTotal: null,
  budgetDaily: null,
  overBudget: "hard-block",
  maxCallsPerWindow: 60,
  windowMs: 60_000,
};

describe("enforce.evaluate — the preventive decision", () => {
  it("allows when under budget and not looping", () => {
    const d = evaluate({ totalCost: 1, dayCost: 0.5, recentCount: 3 }, { ...base, budgetDaily: 5 });
    expect(d.decision).toBe(DECISION.ALLOW);
  });

  it("HARD-BLOCKS at/over the daily budget by default", () => {
    const d = evaluate({ totalCost: 10, dayCost: 5, recentCount: 1 }, { ...base, budgetDaily: 5 });
    expect(d.decision).toBe(DECISION.BLOCK_BUDGET);
    expect(d.scope).toBe("daily");
    expect(d.reason).toContain("hard-block");
    expect(d.reason.toLowerCase()).toContain("estimate");
  });

  it("HARD-BLOCKS at/over the lifetime budget", () => {
    const d = evaluate({ totalCost: 20, dayCost: 0, recentCount: 1 }, { ...base, budgetTotal: 20 });
    expect(d.decision).toBe(DECISION.BLOCK_BUDGET);
    expect(d.scope).toBe("total");
  });

  it('over-budget "warn" forwards but is flagged loudly (opt-in, never silent)', () => {
    const d = evaluate(
      { totalCost: 99, dayCost: 99, recentCount: 1 },
      { ...base, budgetDaily: 5, overBudget: "warn" },
    );
    expect(d.decision).toBe(DECISION.WARN);
    expect(d.reason.toLowerCase()).toContain("not enforced");
  });

  it("runaway-loop kill fires even with NO dollar budget set", () => {
    const d = evaluate({ totalCost: 0, dayCost: 0, recentCount: 60 }, { ...base, maxCallsPerWindow: 60 });
    expect(d.decision).toBe(DECISION.BLOCK_RUNAWAY);
    expect(d.scope).toBe("window");
  });

  it("runaway kill takes precedence over budget message", () => {
    const d = evaluate(
      { totalCost: 100, dayCost: 100, recentCount: 500 },
      { ...base, budgetDaily: 5, maxCallsPerWindow: 60 },
    );
    expect(d.decision).toBe(DECISION.BLOCK_RUNAWAY);
  });

  it("maxCallsPerWindow <= 0 disables the runaway kill (documented escape hatch)", () => {
    const d = evaluate({ totalCost: 0, dayCost: 0, recentCount: 99999 }, { ...base, maxCallsPerWindow: 0 });
    expect(d.decision).toBe(DECISION.ALLOW);
  });

  it("no budgets + under loop limit => allow (accounted but uncapped)", () => {
    const d = evaluate({ totalCost: 12345, dayCost: 999, recentCount: 2 }, { ...base });
    expect(d.decision).toBe(DECISION.ALLOW);
  });
});
