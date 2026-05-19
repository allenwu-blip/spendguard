/**
 * redact.js — the single security chokepoint for "what is safe to emit".
 *
 * spendguard sits IN the LLM API path. It necessarily sees the upstream API
 * key (it must forward it) and the prompt/response bodies (it must stream
 * them through). The HARD product rule:
 *
 *   NEVER log, persist, transmit, or print API keys or full prompt/response
 *   bodies. The key passes through in-memory to the upstream ONLY.
 *
 * Every diagnostic / log line in the codebase MUST go through this module.
 * Nothing else is allowed to format an error that might contain a header
 * value or a body. Spend accounting needs ONLY: token counts + model + a
 * project tag — and that is all the ledger ever stores (see ledger.js).
 *
 * This file is intentionally pure and dependency-free so it is trivially
 * testable, and so the no-leak test can assert its behaviour directly.
 */

// Header names whose VALUE is a credential and must never be emitted.
// Compared case-insensitively. We redact the value, not the name (knowing
// "an x-api-key header was present" is fine; its value is not).
const SECRET_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "x-api-token",
  "openai-api-key",
  "anthropic-api-key",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

// Tokens that look like provider API keys, regardless of where they appear
// (e.g. accidentally embedded in a URL or an upstream error string). These
// are deliberately broad and biased toward over-redaction.
const KEYISH_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g, // OpenAI-style
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic-style (also matched by the above; explicit for clarity)
  /Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, // Authorization: Bearer xxx
  /xoxb-[A-Za-z0-9-]{8,}/g, // misc bot tokens that might be in a proxied path
  /AKIA[0-9A-Z]{12,}/g, // AWS access key id (defensive; upstream errors can echo)
];

const REDACTED = "[REDACTED]";

/**
 * Redact obvious key-shaped substrings anywhere in a string. Used as a
 * defensive last pass on ANY text that will be emitted (an upstream error
 * body we surface, a URL, etc.). Over-redaction is acceptable; leaking is
 * not.
 *
 * @param {unknown} s
 * @returns {string}
 */
export function scrubString(s) {
  if (s == null) return "";
  let out = String(s);
  for (const re of KEYISH_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/**
 * Return a SAFE, log-able view of request headers: secret header values are
 * replaced with [REDACTED]; every remaining value is still scrubbed for
 * key-shaped substrings. Header names are preserved (lower-cased).
 *
 * @param {Record<string,string|string[]>|Headers|undefined} headers
 * @returns {Record<string,string>}
 */
export function safeHeaders(headers) {
  /** @type {Record<string,string>} */
  const out = {};
  if (!headers) return out;
  const entries =
    typeof headers.entries === "function"
      ? [...headers.entries()]
      : Object.entries(headers);
  for (const [kRaw, vRaw] of entries) {
    const k = String(kRaw).toLowerCase();
    if (SECRET_HEADERS.has(k)) {
      out[k] = REDACTED;
      continue;
    }
    const v = Array.isArray(vRaw) ? vRaw.join(", ") : String(vRaw);
    out[k] = scrubString(v);
  }
  return out;
}

/**
 * Strip credential headers OUT of an object entirely (used when we must
 * snapshot headers for forwarding decisions without retaining the secret).
 * The forwarder itself never goes through this — it streams the original
 * headers straight to the socket — this is only for any retained copy.
 *
 * @param {Record<string,string|string[]>} headers
 * @returns {Record<string,string|string[]>}
 */
export function stripSecretHeaders(headers) {
  /** @type {Record<string,string|string[]>} */
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (SECRET_HEADERS.has(String(k).toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Build the ONLY shape of a request that spendguard is permitted to retain
 * or log: method, path, project tag, model (if already known), and a byte
 * length. NO headers values, NO body — ever. `bodyBytes` is a COUNT, the
 * body itself is never captured here.
 *
 * @param {{method?:string, path?:string, project?:string, model?:string, bodyBytes?:number}} r
 * @returns {{method:string, path:string, project:string, model:string|null, bodyBytes:number}}
 */
export function safeRequestMeta(r) {
  return {
    method: scrubString(r.method || "").slice(0, 16),
    // Only the path component, querystrings can carry tokens for some
    // gateways — drop everything after "?".
    path: scrubString(String(r.path || "").split("?")[0]).slice(0, 256),
    project: scrubString(r.project || "default").slice(0, 128),
    model: r.model ? scrubString(r.model).slice(0, 128) : null,
    bodyBytes: Number.isFinite(r.bodyBytes) ? r.bodyBytes : 0,
  };
}

export const _internals = { SECRET_HEADERS, KEYISH_PATTERNS, REDACTED };
