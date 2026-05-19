/**
 * no-leak.test.js — THE security-critical test.
 *
 * spendguard sits in the LLM API path. The non-negotiable contract: it
 * NEVER logs, persists, transmits (other than the legit upstream
 * pass-through), or prints the API key or prompt/response bodies.
 *
 * Method: inject unmistakable SENTINELS —
 *   - SENTINEL_KEY in the Authorization AND x-api-key headers
 *   - SENTINEL_PROMPT in the request body
 *   - the fake upstream echoes SENTINEL_RESPONSE in its (also streamed) body
 * drive real traffic through the proxy (non-streaming + streaming + a
 * blocked request), then ASSERT every sentinel is ABSENT from:
 *   (a) everything the proxy emitted to its log sink
 *   (b) everything the CLI's leak-safe stdout logger emitted
 *   (c) the persisted ledger state file on disk
 *   (d) the persisted feedback file
 * while SIMULTANEOUSLY proving the key WAS delivered to the upstream
 * (passthrough must still work — a proxy that drops the key is useless).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy } from "../src/proxy.js";
import { Ledger } from "../src/ledger.js";
import { resolveConfig } from "../src/config.js";
import { makeSafeLogger } from "../bin/spendguard.js";
import { captureFeedback } from "../src/feedback.js";
import { call } from "./helpers/client.js";
import { startFakeUpstream, anthropicStream } from "./helpers/fake-upstream.js";

const SENTINEL_KEY = "sk-ant-SENTINELKEY-DO-NOT-LOG-9f8e7d6c5b4a3210";
const SENTINEL_PROMPT = "SENTINEL_PROMPT_TEXT_secret_user_source_code_payload";
const SENTINEL_RESPONSE = "SENTINEL_RESPONSE_TEXT_model_output_that_must_not_persist";

let proxy, upstream, dir;
afterEach(async () => {
  if (proxy) await proxy.stop();
  if (upstream) await upstream.close();
  proxy = upstream = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function assertNoSentinels(label, text) {
  expect(text, `${label} must not contain the API key`).not.toContain(SENTINEL_KEY);
  expect(text, `${label} must not contain "sk-ant-SENTINEL"`).not.toContain("sk-ant-SENTINEL");
  expect(text, `${label} must not contain the prompt body`).not.toContain(SENTINEL_PROMPT);
  expect(text, `${label} must not contain the response body`).not.toContain(SENTINEL_RESPONSE);
}

describe("NO-LEAK: key & prompt/response bodies never logged or persisted", () => {
  it("non-streaming + streaming + blocked: sentinels absent everywhere, key still forwarded", async () => {
    dir = mkdtempSync(join(tmpdir(), "sg-noleak-"));
    const statePath = join(dir, "spend-state.json");
    const feedbackSink = join(dir, "feedback.jsonl");

    // Fake upstream echoes the response sentinel in BOTH a JSON body and a
    // streamed body, and records what it received so we can prove the key
    // arrived upstream intact.
    upstream = await startFakeUpstream((req, body, ctx) => {
      if (ctx.count === 2) {
        // 2nd call: stream, with the response sentinel embedded in a chunk.
        // 1,000,000 input tokens => another $3 so the budget math is exact.
        const evts = anthropicStream({ input: 1_000_000, finalOutput: 0 });
        evts.splice(1, 0, `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: SENTINEL_RESPONSE } })}\n\n`);
        return { stream: evts };
      }
      return {
        body: JSON.stringify({
          id: "msg",
          model: "claude-3-5-sonnet-20241022",
          content: [{ type: "text", text: SENTINEL_RESPONSE }],
          // 1,000,000 input tokens => $3/call at the price set below, so
          // the spend sequence is deterministic (see budget math comment).
          usage: { input_tokens: 1_000_000, output_tokens: 0 },
        }),
      };
    });

    // Capture BOTH the raw proxy log objects AND what the CLI's leak-safe
    // logger would print to stdout (the only thing that writes diagnostics).
    const rawLog = [];
    const stdoutLines = [];
    const safeLogger = makeSafeLogger((s) => stdoutLines.push(s));
    const proxyLog = (m) => {
      rawLog.push(m);
      safeLogger(m); // exactly what the CLI does
    };

    const { config, errors } = resolveConfig({
      upstreamBaseUrl: upstream.url,
      port: 0,
      // Deterministic spend sequence at $3/accounted call (1M input tokens
      // x $3/1M): r1 prior $0 -> 200 (now $3). r2 prior $3 < $5 -> 200,
      // streamed (now $6). r3 prior $6 >= $5 -> HARD BLOCK (exercises the
      // block path's redaction). Disable the runaway kill so ONLY the
      // dollar budget gates here.
      budget: 5,
      maxCallsPerWindow: 0,
      pricing: { "claude-3-5-sonnet": { input: 3, output: 15 } },
    });
    expect(errors).toEqual([]);
    config.statePath = statePath;
    const ledger = new Ledger({ statePath });
    proxy = await startProxy(config, { ledger, log: proxyLog });
    const port = proxy.address.port;

    const headers = {
      authorization: `Bearer ${SENTINEL_KEY}`,
      "x-api-key": SENTINEL_KEY,
      "x-spendguard-project": "secretproj",
    };
    const reqBody = JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: SENTINEL_PROMPT }],
    });

    // 1) non-streaming
    const r1 = await call(port, { headers, body: reqBody });
    expect(r1.status).toBe(200);
    expect(r1.body).toContain(SENTINEL_RESPONSE); // passthrough to agent intact

    // 2) streaming
    const r2 = await call(port, { headers, body: reqBody });
    expect(r2.status).toBe(200);
    expect(r2.body).toContain(SENTINEL_RESPONSE); // streamed through intact

    // 3) a 3rd call is now over the (tiny) budget -> hard blocked
    const r3 = await call(port, { headers, body: reqBody });
    expect(r3.status).toBe(429);
    // the blocked error itself must not echo key/prompt
    assertNoSentinels("blocked error body returned to agent", r3.body);

    // also write a feedback note that (legitimately) mentions a budget
    // problem — verbatim store must not be where a key leaks either.
    captureFeedback(feedbackSink, { source: "cli", text: "budget seemed off on project secretproj" });

    await proxy.stop();
    proxy = null;

    // ---- (a) raw proxy log objects: NOTHING sensitive ----
    const rawDump = JSON.stringify(rawLog);
    assertNoSentinels("raw proxy log objects", rawDump);
    // sanity: the proxy DID log accounting facts (proves logging ran, so
    // the absence above is meaningful, not just "it logged nothing")
    expect(rawLog.some((l) => l.event === "accounted")).toBe(true);
    expect(rawLog.some((l) => l.event === "block")).toBe(true);

    // ---- (b) CLI leak-safe stdout: NOTHING sensitive ----
    const stdoutDump = stdoutLines.join("\n");
    assertNoSentinels("CLI stdout logger output", stdoutDump);
    expect(stdoutDump).toContain("accounted"); // it really did print facts
    // it should also have surfaced token counts (non-sensitive)
    expect(stdoutDump).toContain("inputTokens");

    // ---- (c) persisted ledger file on disk: NOTHING sensitive ----
    expect(existsSync(statePath)).toBe(true);
    const stateRaw = readFileSync(statePath, "utf8");
    assertNoSentinels("persisted ledger state file", stateRaw);
    // sanity: it really persisted accounting for the project
    const parsed = JSON.parse(stateRaw);
    expect(parsed.projects.secretproj).toBeTruthy();
    expect(parsed.projects.secretproj.totalInputTokens).toBeGreaterThan(0);

    // ---- (c') no stray temp file left behind that could contain content ----
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      if (full === feedbackSink) continue;
      assertNoSentinels(`file in state dir: ${f}`, readFileSync(full, "utf8"));
    }

    // ---- (d) feedback file: NOTHING sensitive ----
    assertNoSentinels("persisted feedback file", readFileSync(feedbackSink, "utf8"));

    // ---- AND: the key MUST have reached the upstream (passthrough works) ----
    expect(upstream.received.length).toBeGreaterThanOrEqual(2);
    const up0 = upstream.received[0];
    expect(up0.headers["authorization"]).toBe(`Bearer ${SENTINEL_KEY}`);
    expect(up0.headers["x-api-key"]).toBe(SENTINEL_KEY);
    expect(up0.body).toContain(SENTINEL_PROMPT); // body forwarded intact
  });
});
