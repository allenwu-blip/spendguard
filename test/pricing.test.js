import { describe, it, expect } from "vitest";
import {
  buildPricing,
  priceFor,
  estimateCost,
  DEFAULT_PRICING,
  PRICING_DISCLAIMER,
} from "../src/pricing.js";

describe("pricing table", () => {
  it("has a loud user-maintained / not-a-bill disclaimer", () => {
    expect(PRICING_DISCLAIMER.toLowerCase()).toContain("verify");
    expect(PRICING_DISCLAIMER.toLowerCase()).toContain("estimate");
    expect(PRICING_DISCLAIMER.toLowerCase()).toContain("does not bill");
  });

  it("longest-prefix match wins", () => {
    const t = buildPricing();
    expect(priceFor(t, "claude-3-5-sonnet-20241022").matched).toBe("claude-3-5-sonnet");
    expect(priceFor(t, "gpt-4o-mini-2024").matched).toBe("gpt-4o-mini");
  });

  it("unknown model NEVER costs $0 — falls back to the * row", () => {
    const t = buildPricing();
    const p = priceFor(t, "totally-unknown-model-xyz");
    expect(p.matched).toBe("*");
    const cost = estimateCost(p, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeGreaterThan(0);
  });

  it("user override merges over defaults and can add new models", () => {
    const t = buildPricing({
      "claude-3-5-sonnet": { input: 99, output: 199 },
      "my-local-llm": { input: 0, output: 0 },
    });
    expect(priceFor(t, "claude-3-5-sonnet-x").input).toBe(99);
    expect(priceFor(t, "my-local-llm-7b").matched).toBe("my-local-llm");
    // an unrelated default is untouched
    expect(priceFor(t, "gpt-4o").input).toBe(DEFAULT_PRICING["gpt-4o"].input);
  });

  it("estimateCost = tokens x price / 1e6, cache defaults to input price", () => {
    const cost = estimateCost(
      { input: 3, output: 15 },
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 },
    );
    // 3 + 15 + 3 (cacheRead defaults to input price) = 21
    expect(cost).toBeCloseTo(21, 9);
  });

  it("ignores malformed override entries (negative / non-number)", () => {
    const t = buildPricing({ "gpt-4o": { input: -5 }, junk: "nope" });
    // negative rejected -> default retained
    expect(priceFor(t, "gpt-4o").input).toBe(DEFAULT_PRICING["gpt-4o"].input);
  });
});
