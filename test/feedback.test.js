import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureFeedback, loadFeedback } from "../src/feedback.js";

let dir, sink;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sg-fb-"));
  sink = join(dir, "feedback.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("verbatim feedback contract", () => {
  it("stores text EXACTLY as written — no trim/normalize", () => {
    const messy = "  budget did NOT hold: set $5/day, kept forwarding past $9\n\n  -- streaming case  ";
    captureFeedback(sink, { source: "issue", text: messy });
    const rec = JSON.parse(readFileSync(sink, "utf8").trim());
    expect(rec.text).toBe(messy);
    expect(rec.product).toBe("spendguard");
    expect(rec.source).toBe("issue");
  });

  it("is append-only and order-preserving", () => {
    captureFeedback(sink, { source: "cli", text: "first" });
    captureFeedback(sink, { source: "cli", text: "second" });
    const g = loadFeedback(sink);
    expect(g.cli.map((r) => r.text)).toEqual(["first", "second"]);
  });

  it("a single corrupt record never aborts the read", () => {
    captureFeedback(sink, { source: "issue", text: "good one" });
    writeFileSync(sink, readFileSync(sink, "utf8") + "{ not json\n");
    captureFeedback(sink, { source: "issue", text: "good two" });
    const g = loadFeedback(sink);
    expect(g.issue.map((r) => r.text)).toEqual(["good one", "good two"]);
  });

  it("returns {} when the sink does not exist", () => {
    expect(loadFeedback(join(dir, "absent.jsonl"))).toEqual({});
  });
});
