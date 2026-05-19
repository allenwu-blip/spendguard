import { describe, it, expect } from "vitest";
import {
  scrubString,
  safeHeaders,
  stripSecretHeaders,
  safeRequestMeta,
} from "../src/redact.js";

describe("redact — the security chokepoint", () => {
  it("scrubs OpenAI / Anthropic / Bearer key shapes anywhere", () => {
    expect(scrubString("key=sk-ant-abc123DEF456ghi789")).not.toContain("sk-ant-abc123");
    expect(scrubString("Authorization: Bearer abcd1234efgh5678")).not.toContain("abcd1234efgh5678");
    expect(scrubString("sk-proj-XXXXXXXXXXXX")).toBe("[REDACTED]");
    expect(scrubString("nothing secret here")).toBe("nothing secret here");
  });

  it("safeHeaders replaces credential header VALUES, keeps names", () => {
    const h = safeHeaders({
      authorization: "Bearer sk-ant-SECRETSECRETSECRET",
      "x-api-key": "sk-SECRETSECRETSECRET",
      "anthropic-version": "2023-06-01",
      "user-agent": "agent/1.0",
    });
    expect(h.authorization).toBe("[REDACTED]");
    expect(h["x-api-key"]).toBe("[REDACTED]");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.stringify(h)).not.toContain("SECRET");
  });

  it("stripSecretHeaders removes credential headers entirely", () => {
    const s = stripSecretHeaders({ authorization: "x", "x-api-key": "y", accept: "application/json" });
    expect(s.authorization).toBeUndefined();
    expect(s["x-api-key"]).toBeUndefined();
    expect(s.accept).toBe("application/json");
  });

  it("safeRequestMeta drops query string (gateways can put tokens there) and body", () => {
    const m = safeRequestMeta({
      method: "POST",
      path: "/v1/messages?api_key=sk-ant-LEAKYLEAKYLEAKY",
      project: "billing",
      bodyBytes: 123,
    });
    expect(m.path).toBe("/v1/messages");
    expect(JSON.stringify(m)).not.toContain("LEAKY");
    expect(m).not.toHaveProperty("body");
    expect(m.bodyBytes).toBe(123);
  });
});
