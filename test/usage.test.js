import { describe, it, expect } from "vitest";
import {
  parseNonStreaming,
  StreamingUsageAccumulator,
  usageFromJsonObject,
  isStreamingContentType,
} from "../src/usage.js";
import {
  anthropicJson,
  openaiJson,
  anthropicStream,
  openaiStream,
  openaiStreamNoUsage,
} from "./helpers/fake-upstream.js";

describe("non-streaming usage parsing", () => {
  it("parses Anthropic usage incl. cache tokens", () => {
    const u = parseNonStreaming(
      anthropicJson({ model: "claude-3-5-sonnet-20241022", input: 1000, output: 500, cacheRead: 200, cacheWrite: 50 }),
    );
    expect(u.inputTokens).toBe(1000);
    expect(u.outputTokens).toBe(500);
    expect(u.cacheReadTokens).toBe(200);
    expect(u.cacheWriteTokens).toBe(50);
    expect(u.model).toBe("claude-3-5-sonnet-20241022");
    expect(u.incomplete).toBe(false);
  });

  it("parses OpenAI-compatible usage", () => {
    const u = parseNonStreaming(openaiJson({ model: "gpt-4o", input: 800, output: 200 }));
    expect(u.inputTokens).toBe(800);
    expect(u.outputTokens).toBe(200);
    expect(u.model).toBe("gpt-4o");
  });

  it("marks a 2xx with no readable usage as incomplete (never silently 0-cost)", () => {
    const u = parseNonStreaming(JSON.stringify({ model: "mystery-model", choices: [] }));
    expect(u.incomplete).toBe(true);
    expect(u.model).toBe("mystery-model");
  });

  it("marks unparseable bodies incomplete (does not throw)", () => {
    const u = parseNonStreaming("<<not json>>");
    expect(u.incomplete).toBe(true);
    expect(u.inputTokens).toBe(0);
  });
});

describe("STREAMING usage accounting (must not undercount)", () => {
  it("Anthropic SSE: ends with the FINAL cumulative output_tokens, not the first", () => {
    const acc = new StreamingUsageAccumulator();
    for (const ev of anthropicStream({ input: 1200, finalOutput: 900 })) acc.push(ev);
    const u = acc.end();
    expect(u.inputTokens).toBe(1200);
    expect(u.outputTokens).toBe(900); // NOT 1 (message_start) and NOT 450 (mid delta)
    expect(u.incomplete).toBe(false);
  });

  it("Anthropic SSE survives chunk boundaries splitting an event mid-way", () => {
    const acc = new StreamingUsageAccumulator();
    const full = anthropicStream({ input: 1200, finalOutput: 900 }).join("");
    // feed it 7 bytes at a time to simulate TCP fragmentation
    for (let i = 0; i < full.length; i += 7) acc.push(full.slice(i, i + 7));
    const u = acc.end();
    expect(u.inputTokens).toBe(1200);
    expect(u.outputTokens).toBe(900);
  });

  it("OpenAI-compatible SSE: picks up the terminal usage chunk", () => {
    const acc = new StreamingUsageAccumulator();
    for (const ev of openaiStream({ input: 700, output: 350 })) acc.push(ev);
    const u = acc.end();
    expect(u.inputTokens).toBe(700);
    expect(u.outputTokens).toBe(350);
    expect(u.incomplete).toBe(false);
  });

  it("OpenAI-compatible SSE with NO usage chunk is flagged incomplete (not silent $0)", () => {
    const acc = new StreamingUsageAccumulator();
    for (const ev of openaiStreamNoUsage()) acc.push(ev);
    const u = acc.end();
    expect(u.incomplete).toBe(true);
    expect(u.outputTokens).toBe(0);
  });
});

describe("misc", () => {
  it("usageFromJsonObject returns null when no usage present", () => {
    expect(usageFromJsonObject({ foo: 1 })).toBeNull();
    expect(usageFromJsonObject(null)).toBeNull();
  });
  it("detects event-stream content type", () => {
    expect(isStreamingContentType("text/event-stream; charset=utf-8")).toBe(true);
    expect(isStreamingContentType("application/json")).toBe(false);
    expect(isStreamingContentType(undefined)).toBe(false);
  });
});
