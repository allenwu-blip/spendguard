import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, parseArgs, mergeConfig } from "../bin/spendguard.js";
import { joinUpstream } from "../src/proxy.js";

let out, err, dir;
beforeEach(() => {
  out = [];
  err = [];
  dir = mkdtempSync(join(tmpdir(), "sg-cli-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const O = (s) => out.push(s);
const E = (s) => err.push(s);

describe("CLI", () => {
  it("--help exits 0 and states the security posture + not-a-bill", async () => {
    const code = await run(["--help"], O, E);
    expect(code).toBe(0);
    const t = out.join("\n");
    expect(t).toMatch(/NEVER log/i);
    expect(t).toMatch(/localhost only/i);
    expect(t).toMatch(/not a billing system/i);
    expect(t).toMatch(/over-budget => BLOCK by default/i);
  });

  it("no command prints help and exits 2", async () => {
    const code = await run([], O, E);
    expect(code).toBe(2);
  });

  it("`pricing` prints the table and the verify/estimate disclaimer", async () => {
    const code = await run(["pricing"], O, E);
    expect(code).toBe(0);
    const t = out.join("\n");
    expect(t.toLowerCase()).toContain("verify");
    expect(t.toLowerCase()).toContain("estimate");
    expect(t).toContain("claude-3-5-sonnet");
    expect(t).toContain("*"); // fallback row shown
  });

  it("`status --json` on an empty state dir is valid JSON with the disclaimer", async () => {
    const code = await run(["status", "--json", "--state-dir", dir], O, E);
    expect(code).toBe(0);
    const j = JSON.parse(out.join("\n"));
    expect(j.tool).toBe("spendguard");
    expect(j.disclaimer.toLowerCase()).toContain("estimate");
    expect(j.projects).toEqual({});
  });

  it("`feedback` requires text and stores it verbatim under the state dir", async () => {
    const bad = await run(["feedback"], O, E);
    expect(bad).toBe(2);
    expect(err.join("")).toMatch(/feedback text is required/);

    out.length = 0;
    const ok = await run(["feedback", "budget   did NOT  hold!!", "--state-dir", dir], O, E);
    expect(ok).toBe(0);
    const sink = join(dir, "feedback.jsonl");
    expect(existsSync(sink)).toBe(true);
    const rec = JSON.parse(readFileSync(sink, "utf8").trim());
    expect(rec.text).toBe("budget   did NOT  hold!!"); // verbatim incl. spaces
    expect(rec.product).toBe("spendguard");
  });

  it("rejects a non-loopback --host with a clear error (exit 2)", async () => {
    const code = await run(["start", "--host", "0.0.0.0", "--state-dir", dir], O, E);
    expect(code).toBe(2);
    expect(err.join("")).toMatch(/loopback/i);
  });

  it("parseArgs handles --flag=value and the feedback trailing text", () => {
    const { o } = parseArgs(["start", "--port=9000", "--over-budget=warn"]);
    expect(o.cmd).toBe("start");
    expect(o.port).toBe("9000");
    expect(o.overBudget).toBe("warn");
    const { o: o2 } = parseArgs(["feedback", "this", "is", "verbatim"]);
    expect(o2.text).toBe("this is verbatim");
  });

  it("mergeConfig: CLI flags win over the file", () => {
    const m = mergeConfig({ port: 1, budget: 5 }, { port: 2, budget: undefined });
    expect(m.port).toBe(2); // CLI wins
    expect(m.budget).toBe(5); // file kept when CLI absent
  });
});

describe("joinUpstream (pure path join)", () => {
  it("plain base + request path", () => {
    const u = joinUpstream(new URL("https://api.anthropic.com"), "/v1/messages?x=1");
    expect(u.toString()).toBe("https://api.anthropic.com/v1/messages?x=1");
  });
  it("base WITH a base path (enterprise gateway) is a prefix", () => {
    const u = joinUpstream(new URL("https://gw.example.com/llm/"), "/v1/chat/completions");
    expect(u.toString()).toBe("https://gw.example.com/llm/v1/chat/completions");
  });
  it("preserves query string, drops nothing", () => {
    const u = joinUpstream(new URL("http://127.0.0.1:1234/v1"), "/messages?beta=true&a=b");
    expect(u.toString()).toBe("http://127.0.0.1:1234/v1/messages?beta=true&a=b");
  });
});
