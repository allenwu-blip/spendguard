import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startProxy } from "../src/proxy.js";
import { Ledger } from "../src/ledger.js";
import { resolveConfig } from "../src/config.js";
import { call } from "./helpers/client.js";
import {
  startFakeUpstream,
  anthropicJson,
  openaiJson,
  anthropicStream,
  openaiStream,
} from "./helpers/fake-upstream.js";

/**
 * Every test here runs the REAL proxy against a LOCAL fake upstream on
 * 127.0.0.1. No external network, no API key. We pass an in-memory Ledger
 * (statePath null) unless a test specifically checks persistence.
 */

let upstream, proxy, logs;

async function boot(rawConfig, ledger) {
  logs = [];
  const { config, errors } = resolveConfig({
    upstreamBaseUrl: upstream.url,
    port: 0,
    ...rawConfig,
  });
  expect(errors).toEqual([]);
  proxy = await startProxy(config, {
    ledger,
    log: (m) => logs.push(m),
  });
  return proxy.address.port;
}

afterEach(async () => {
  if (proxy) await proxy.stop();
  if (upstream) await upstream.close();
  proxy = upstream = null;
});

describe("proxy: forwarding + accounting", () => {
  it("forwards non-streaming Anthropic and accounts tokens & est cost", async () => {
    upstream = await startFakeUpstream(() => ({
      body: anthropicJson({ model: "claude-3-5-sonnet-20241022", input: 1000, output: 500 }),
    }));
    const ledger = new Ledger();
    const port = await boot({ pricing: { "claude-3-5-sonnet": { input: 3, output: 15 } } }, ledger);

    const res = await call(port, { headers: { "x-spendguard-project": "alpha" }, body: { messages: [] } });
    expect(res.status).toBe(200);
    // body passed through faithfully
    expect(res.body).toContain("FAKE_ASSISTANT_REPLY_CONTENT");

    const s = ledger.summary().alpha;
    expect(s.totalInputTokens).toBe(1000);
    expect(s.totalOutputTokens).toBe(500);
    // 1000/1e6*3 + 500/1e6*15 = 0.003 + 0.0075 = 0.0105
    expect(s.totalCost).toBeCloseTo(0.0105, 9);
  });

  it("forwards OpenAI-compatible upstream too (pass-through infra)", async () => {
    upstream = await startFakeUpstream(() => ({ body: openaiJson({ model: "gpt-4o", input: 800, output: 200 }) }));
    const ledger = new Ledger();
    const port = await boot({ pricing: { "gpt-4o": { input: 2.5, output: 10 } } }, ledger);
    const res = await call(port, { path: "/v1/chat/completions", headers: { "x-spendguard-project": "oai" }, body: {} });
    expect(res.status).toBe(200);
    expect(res.body).toContain("FAKE_OPENAI_REPLY");
    const s = ledger.summary().oai;
    expect(s.totalInputTokens).toBe(800);
    expect(s.totalOutputTokens).toBe(200);
  });

  it("STREAMING: accounts the FINAL streamed token count (no undercount) and streams body through", async () => {
    upstream = await startFakeUpstream(() => ({ stream: anthropicStream({ input: 1200, finalOutput: 900 }) }));
    const ledger = new Ledger();
    const port = await boot({ pricing: { "claude-3-5-sonnet": { input: 3, output: 15 } } }, ledger);
    const res = await call(port, { headers: { "x-spendguard-project": "stream" }, body: {} });
    expect(res.status).toBe(200);
    expect(res.body).toContain("FAKE_STREAM_CHUNK_1");
    expect(res.body).toContain("message_stop");
    const s = ledger.summary().stream;
    expect(s.totalInputTokens).toBe(1200);
    expect(s.totalOutputTokens).toBe(900); // the FINAL cumulative value
  });

  it("STREAMING OpenAI-compatible terminal usage chunk is accounted", async () => {
    upstream = await startFakeUpstream(() => ({ stream: openaiStream({ input: 700, output: 350 }) }));
    const ledger = new Ledger();
    const port = await boot({}, ledger);
    const res = await call(port, { path: "/v1/chat/completions", headers: { "x-spendguard-project": "os" }, body: {} });
    expect(res.status).toBe(200);
    const s = ledger.summary().os;
    expect(s.totalInputTokens).toBe(700);
    expect(s.totalOutputTokens).toBe(350);
  });

  it("attributes spend per project (header) — separate ledgers", async () => {
    upstream = await startFakeUpstream(() => ({ body: anthropicJson({ input: 100, output: 100 }) }));
    const ledger = new Ledger();
    const port = await boot({}, ledger);
    await call(port, { headers: { "x-spendguard-project": "repo-a" }, body: {} });
    await call(port, { headers: { "x-spendguard-project": "repo-a" }, body: {} });
    await call(port, { headers: { "x-spendguard-project": "repo-b" }, body: {} });
    const sum = ledger.summary();
    expect(sum["repo-a"].totalCalls).toBe(2);
    expect(sum["repo-b"].totalCalls).toBe(1);
    expect(sum["repo-a"].totalInputTokens).toBe(200);
  });

  it("falls back to default project when no header given", async () => {
    upstream = await startFakeUpstream(() => ({ body: anthropicJson({ input: 10, output: 10 }) }));
    const ledger = new Ledger();
    const port = await boot({ defaultProject: "myproj" }, ledger);
    await call(port, { body: {} });
    expect(ledger.summary().myproj.totalCalls).toBe(1);
  });
});

describe("proxy: PREVENTIVE enforcement (the whole point)", () => {
  it("HARD-BLOCKS once the project has ALREADY accrued >= budget — upstream NOT contacted on the block", async () => {
    // Preventive semantics: spendguard cannot know a call's token cost
    // before making it (usage is only in the response). So it blocks the
    // NEXT call once the project's accrued spend is already at/over budget.
    // Setup: $3/call, daily budget $5. r1 prior=$0 -> allow ($3 total).
    // r2 prior=$3 (<$5) -> allow ($6 total). r3 prior=$6 (>=$5) -> BLOCK,
    // and the upstream must NOT be contacted for r3.
    let upstreamHits = 0;
    upstream = await startFakeUpstream(() => {
      upstreamHits++;
      return { body: anthropicJson({ model: "claude-3-5-sonnet-20241022", input: 1_000_000, output: 0 }) };
    });
    const ledger = new Ledger();
    const port = await boot(
      { budget: 5, pricing: { "claude-3-5-sonnet": { input: 3, output: 0 } } },
      ledger,
    );
    const r1 = await call(port, { headers: { "x-spendguard-project": "p" }, body: {} });
    expect(r1.status).toBe(200); // prior $0 -> allowed; now $3
    const r2 = await call(port, { headers: { "x-spendguard-project": "p" }, body: {} });
    expect(r2.status).toBe(200); // prior $3 < $5 -> allowed; now $6
    const hitsBeforeBlock = upstreamHits;

    const r3 = await call(port, { headers: { "x-spendguard-project": "p" }, body: {} });
    expect(r3.status).toBe(429); // prior $6 >= $5 -> hard blocked
    expect(upstreamHits).toBe(hitsBeforeBlock); // upstream NEVER contacted on the block
    const err = JSON.parse(r3.body);
    expect(err.error.type).toBe("spendguard_budget_blocked");
    expect(err.error.message).toContain("over its daily budget");
    expect(err.error.message.toLowerCase()).toContain("estimate");

    // sanity: a DIFFERENT project with its own budget is unaffected
    const other = await call(port, { headers: { "x-spendguard-project": "fresh" }, body: {} });
    expect(other.status).toBe(200);
  });

  it('"warn" over-budget forwards anyway but flags it (opt-in, never silent)', async () => {
    let hits = 0;
    upstream = await startFakeUpstream(() => {
      hits++;
      return { body: anthropicJson({ model: "claude-3-5-sonnet-20241022", input: 1_000_000, output: 0 }) };
    });
    const ledger = new Ledger();
    const port = await boot(
      { budget: 1, overBudget: "warn", pricing: { "claude-3-5-sonnet": { input: 3, output: 0 } } },
      ledger,
    );
    await call(port, { headers: { "x-spendguard-project": "p" }, body: {} }); // $3 > $1
    const r2 = await call(port, { headers: { "x-spendguard-project": "p" }, body: {} });
    expect(r2.status).toBe(200); // warn => still forwarded
    expect(hits).toBe(2);
    expect(logs.some((l) => l.event === "warn")).toBe(true);
  });

  it("KILLS a runaway loop: N calls in the window are blocked", async () => {
    let hits = 0;
    upstream = await startFakeUpstream(() => {
      hits++;
      return { body: anthropicJson({ input: 1, output: 1 }) };
    });
    const ledger = new Ledger({ windowMs: 60_000 });
    // canonical config keys (boot() -> resolveConfig directly)
    const port = await boot({ maxCallsPerWindow: 3, windowMs: 60_000 }, ledger);
    const codes = [];
    for (let i = 0; i < 6; i++) {
      const r = await call(port, { headers: { "x-spendguard-project": "loopy" }, body: {} });
      codes.push(r.status);
    }
    // first 3 allowed, the rest killed
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes.slice(3)).toEqual([429, 429, 429]);
    expect(hits).toBe(3);
    const blocked = JSON.parse((await call(port, { headers: { "x-spendguard-project": "loopy" }, body: {} })).body);
    expect(blocked.error.type).toBe("spendguard_runaway_blocked");
  });

  it("incompleteUsage block-next refuses the next call after an unaccountable stream", async () => {
    // OpenAI-compatible stream with NO usage chunk -> incomplete
    const { openaiStreamNoUsage } = await import("./helpers/fake-upstream.js");
    upstream = await startFakeUpstream(() => ({ stream: openaiStreamNoUsage() }));
    const ledger = new Ledger();
    const port = await boot({ incompleteUsage: "block-next" }, ledger);
    const r1 = await call(port, { path: "/v1/chat/completions", headers: { "x-spendguard-project": "blind" }, body: {} });
    expect(r1.status).toBe(200); // first one streams through
    const r2 = await call(port, { path: "/v1/chat/completions", headers: { "x-spendguard-project": "blind" }, body: {} });
    expect(r2.status).toBe(429);
    expect(JSON.parse(r2.body).error.type).toBe("spendguard_incomplete_usage");
  });
});

describe("proxy: persistence", () => {
  it("persists the ledger atomically and reloads spend across restarts", async () => {
    const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "sg-state-"));
    const statePath = join(dir, "spend-state.json");
    try {
      upstream = await startFakeUpstream(() => ({ body: anthropicJson({ input: 500, output: 500 }) }));
      let ledger = new Ledger({ statePath });
      let port = await boot({}, ledger);
      await call(port, { headers: { "x-spendguard-project": "persist" }, body: {} });
      await proxy.stop();
      proxy = null;
      expect(existsSync(statePath)).toBe(true);

      // reload: a fresh Ledger from the same file must see prior spend
      const reloaded = new Ledger({ statePath });
      expect(reloaded.summary().persist.totalCalls).toBe(1);
      expect(reloaded.summary().persist.totalInputTokens).toBe(500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("proxy: refuses to bind a non-loopback host", () => {
  it("startProxy rejects host 0.0.0.0 even if config somehow had it", async () => {
    upstream = await startFakeUpstream(() => ({ body: "{}" }));
    const { config } = resolveConfig({ upstreamBaseUrl: upstream.url, port: 0 });
    config.host = "0.0.0.0"; // force it past config validation
    await expect(startProxy(config, { ledger: new Ledger() })).rejects.toThrow(/loopback/i);
  });
});

describe("proxy: concurrency overshoot (documented behavior)", () => {
  it(
    "N truly-concurrent requests all forward when budget only allows K (in-flight overshoot == in-flight count)" +
      " AND the guard recovers — next serialized call IS blocked after they settle",
    async () => {
      // Documented invariant: the guard is a preventive cap, not a hard
      // ceiling. Under genuine concurrency every in-flight request passes
      // the pre-forward budget check before any completes and books spend.
      // Setup: $3/call, daily budget $5 (allows K=1 full call; 2nd would
      // push to $6 > $5 but only AFTER the first response lands).
      // We fire M=4 requests simultaneously. All 4 pass the pre-forward
      // check while the ledger still shows $0, so all 4 are forwarded.
      // After they settle the ledger shows $12 >> $5. The NEXT serialized
      // call MUST be blocked (guard recovers correctly).
      const M = 4; // concurrent in-flight requests
      let upstreamHits = 0;
      upstream = await startFakeUpstream(() => {
        upstreamHits++;
        return {
          body: anthropicJson({
            model: "claude-3-5-sonnet-20241022",
            input: 1_000_000,
            output: 0,
          }),
        };
      });
      const ledger = new Ledger();
      const port = await boot(
        { budget: 5, pricing: { "claude-3-5-sonnet": { input: 3, output: 0 } } },
        ledger,
      );

      // Fire M requests simultaneously — Promise.all, not sequential awaits.
      const responses = await Promise.all(
        Array.from({ length: M }, () =>
          call(port, {
            headers: { "x-spendguard-project": "concurrent" },
            body: {},
          }),
        ),
      );

      // ALL M in-flight requests must have been forwarded (all 4 × $3 = $12).
      // This documents the in-flight overshoot: each passed the pre-forward
      // budget check while the ledger still reflected $0.
      const forwarded = responses.filter((r) => r.status === 200).length;
      expect(forwarded).toBe(M);
      expect(upstreamHits).toBe(M);

      // Guard recovery: once all spend is booked the NEXT serialized call
      // must be blocked — ledger now shows $12 which is >> $5 budget.
      const afterSettle = await call(port, {
        headers: { "x-spendguard-project": "concurrent" },
        body: {},
      });
      expect(afterSettle.status).toBe(429);
      expect(JSON.parse(afterSettle.body).error.type).toBe("spendguard_budget_blocked");
    },
  );
});
