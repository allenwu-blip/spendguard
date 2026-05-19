import { describe, it, expect } from "vitest";
import { resolveConfig, DEFAULTS } from "../src/config.js";

describe("resolveConfig — security defaults enforced in code", () => {
  it("defaults: localhost, hard-block, runaway kill on", () => {
    const { config, errors } = resolveConfig({});
    expect(errors).toEqual([]);
    expect(config.host).toBe("127.0.0.1");
    expect(config.overBudget).toBe("hard-block");
    expect(config.maxCallsPerWindow).toBe(DEFAULTS.maxCallsPerWindow);
  });

  it("REJECTS a non-loopback host (key-holding proxy must be localhost only)", () => {
    const { errors } = resolveConfig({ host: "0.0.0.0" });
    expect(errors.join(" ")).toMatch(/loopback/i);
    const r2 = resolveConfig({ host: "192.168.1.5" });
    expect(r2.errors.join(" ")).toMatch(/loopback/i);
  });

  it("accepts loopback aliases and normalizes localhost -> 127.0.0.1", () => {
    expect(resolveConfig({ host: "localhost" }).config.host).toBe("127.0.0.1");
    expect(resolveConfig({ host: "::1" }).config.host).toBe("::1");
    expect(resolveConfig({ host: "127.0.0.1" }).errors).toEqual([]);
  });

  it("`budget` shorthand maps to the DAILY cap", () => {
    const { config } = resolveConfig({ budget: 7 });
    expect(config.budgetDaily).toBe(7);
    expect(config.budgetTotal).toBe(null);
  });

  it("explicit budgetDaily/budgetTotal both honored", () => {
    const { config } = resolveConfig({ budgetDaily: 3, budgetTotal: 50 });
    expect(config.budgetDaily).toBe(3);
    expect(config.budgetTotal).toBe(50);
  });

  it("rejects bad port / bad upstream / bad overBudget / negative budget", () => {
    expect(resolveConfig({ port: 99999 }).errors.length).toBe(1);
    expect(resolveConfig({ upstreamBaseUrl: "not a url" }).errors.length).toBe(1);
    expect(resolveConfig({ overBudget: "ignore" }).errors.length).toBe(1);
    expect(resolveConfig({ budget: -1 }).errors.length).toBe(1);
  });

  it("accepts an upstream WITH a base path (enterprise gateway)", () => {
    const { config, errors } = resolveConfig({ upstreamBaseUrl: "https://gw.example.com/llm/" });
    expect(errors).toEqual([]);
    expect(config.upstreamBaseUrl).toBe("https://gw.example.com/llm");
  });

  it("accepts an OpenAI-compatible upstream (pass-through infra, not our LLM use)", () => {
    const { config, errors } = resolveConfig({ upstreamBaseUrl: "http://127.0.0.1:1234/v1" });
    expect(errors).toEqual([]);
    expect(config.upstreamBaseUrl).toBe("http://127.0.0.1:1234/v1");
  });

  it("incompleteUsage policy defaults to count-zero, accepts block-next", () => {
    expect(resolveConfig({}).config.incompleteUsage).toBe("count-zero");
    expect(resolveConfig({ incompleteUsage: "block-next" }).config.incompleteUsage).toBe("block-next");
  });

  it("WARNS on an unknown/misspelled key (a silently-unenforced budget is the worst failure)", () => {
    const { warnings, errors } = resolveConfig({ maxCalls: 3, budget: 5 });
    expect(errors).toEqual([]); // non-fatal
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/maxCalls/);
    expect(warnings[0].toLowerCase()).toContain("not enforced");
    // a fully-correct config produces no warnings
    expect(resolveConfig({ maxCallsPerWindow: 3, budget: 5 }).warnings).toEqual([]);
  });
});
