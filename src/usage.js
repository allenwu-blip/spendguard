/**
 * usage.js — extract token usage from upstream LLM responses.
 *
 * spendguard counts tokens from the API's OWN usage fields (it does not
 * tokenize prompt text itself — that would require reading content, which
 * the security posture forbids retaining anyway). It supports the two
 * dominant shapes a coding agent will hit:
 *
 *  - Anthropic Messages: non-streaming JSON `usage:{input_tokens,
 *    output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`;
 *    streaming SSE where `message_start` carries input + an initial output,
 *    and `message_delta` carries the cumulative/final `usage.output_tokens`.
 *  - OpenAI-compatible: non-streaming JSON `usage:{prompt_tokens,
 *    completion_tokens}`; streaming SSE that (when the caller sets
 *    `stream_options:{include_usage:true}`) emits a final chunk whose
 *    `usage` is the totals. If a streamed OpenAI-compatible response never
 *    includes usage, spendguard CANNOT invent it — see `incomplete`.
 *
 * CRITICAL streaming rule: a budget guard must NOT undercount streamed
 * completions. The parser tracks the LAST/most-complete usage object seen
 * in the stream (Anthropic's `message_delta` output_tokens is cumulative;
 * OpenAI's final usage chunk is the total) rather than, say, only the first
 * event. The body bytes are scanned for usage and then DISCARDED — content
 * is never returned or stored.
 */

/**
 * Normalised usage shape used everywhere downstream.
 * @typedef {{
 *   inputTokens:number, outputTokens:number,
 *   cacheReadTokens:number, cacheWriteTokens:number,
 *   model:string|null, incomplete:boolean
 * }} Usage
 */

function zeroUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    model: null,
    incomplete: false,
  };
}

function n(x) {
  const v = Number(x);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Pull a usage object out of one parsed JSON value (Anthropic OR OpenAI
 * shape). Returns null if there is no usage in it.
 * @param {any} obj
 * @returns {Usage|null}
 */
export function usageFromJsonObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  const model = typeof obj.model === "string" ? obj.model : null;

  // OpenAI-compatible
  const ou = obj.usage;
  if (ou && (ou.prompt_tokens != null || ou.completion_tokens != null)) {
    const u = zeroUsage();
    u.inputTokens = n(ou.prompt_tokens);
    u.outputTokens = n(ou.completion_tokens);
    // Some OpenAI-compatible servers expose cached prompt tokens.
    const ptd = ou.prompt_tokens_details || {};
    u.cacheReadTokens = n(ptd.cached_tokens);
    u.model = model;
    return u;
  }

  // Anthropic Messages
  if (ou && (ou.input_tokens != null || ou.output_tokens != null)) {
    const u = zeroUsage();
    u.inputTokens = n(ou.input_tokens);
    u.outputTokens = n(ou.output_tokens);
    u.cacheReadTokens = n(ou.cache_read_input_tokens);
    u.cacheWriteTokens = n(ou.cache_creation_input_tokens);
    u.model = model;
    return u;
  }

  // Anthropic streaming events embed usage under message/usage.
  if (obj.message && obj.message.usage) {
    const mu = obj.message.usage;
    const u = zeroUsage();
    u.inputTokens = n(mu.input_tokens);
    u.outputTokens = n(mu.output_tokens);
    u.cacheReadTokens = n(mu.cache_read_input_tokens);
    u.cacheWriteTokens = n(mu.cache_creation_input_tokens);
    u.model = typeof obj.message.model === "string" ? obj.message.model : model;
    return u;
  }

  return null;
}

/**
 * Parse a complete NON-streaming response body (a single JSON document).
 * @param {string|Buffer} body
 * @returns {Usage}
 */
export function parseNonStreaming(body) {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "");
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    const u = zeroUsage();
    u.incomplete = true; // unparseable -> we could not account it
    return u;
  }
  const u = usageFromJsonObject(obj);
  if (!u) {
    const z = zeroUsage();
    z.model = obj && typeof obj.model === "string" ? obj.model : null;
    z.incomplete = true; // a 2xx with no usage we can read
    return z;
  }
  return u;
}

/**
 * Stateful accumulator for a STREAMED (SSE) response. Feed it raw chunks as
 * they arrive; it never buffers or returns content, only the evolving
 * usage. Anthropic: input_tokens arrives at message_start; output_tokens is
 * updated by each message_delta (cumulative) — we keep the MAX so a final
 * count is never lost if events arrive out of order or the last is partial.
 * OpenAI-compatible: a single terminal usage chunk holds the totals; we
 * take it as-is.
 */
export class StreamingUsageAccumulator {
  constructor() {
    this._u = zeroUsage();
    this._sawAnyUsage = false;
    this._buf = "";
    this._sawOpenAiDone = false;
    this._isOpenAiStream = false;
  }

  /** @param {string|Buffer} chunk */
  push(chunk) {
    this._buf += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    // SSE events are separated by a blank line. Process complete events;
    // keep the trailing partial in the buffer. We deliberately retain only
    // the small unparsed tail, never the assembled content.
    let idx;
    while ((idx = this._indexOfEventBoundary(this._buf)) !== -1) {
      const rawEvent = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx).replace(/^(\r?\n)+/, "");
      this._consumeEvent(rawEvent);
    }
  }

  _indexOfEventBoundary(s) {
    const a = s.indexOf("\n\n");
    const b = s.indexOf("\r\n\r\n");
    if (a === -1) return b;
    if (b === -1) return a;
    return Math.min(a, b);
  }

  _consumeEvent(rawEvent) {
    // Concatenate all `data:` lines in this event (SSE allows multi-line).
    const dataLines = [];
    for (const line of rawEvent.split(/\r?\n/)) {
      const m = /^data:\s?(.*)$/.exec(line);
      if (m) dataLines.push(m[1]);
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n").trim();
    if (data === "" ) return;
    if (data === "[DONE]") {
      this._sawOpenAiDone = true;
      return;
    }
    let obj;
    try {
      obj = JSON.parse(data);
    } catch {
      return; // ignore an unparseable event; never store it
    }
    if (obj && obj.object && String(obj.object).startsWith("chat.completion")) {
      this._isOpenAiStream = true;
    }
    const found = usageFromJsonObject(obj);
    if (!found) return;
    this._sawAnyUsage = true;
    // Merge conservatively: take the MAX of each token field seen so far.
    // (Anthropic message_delta output_tokens is cumulative; OpenAI's final
    // usage chunk is the grand total — max() is correct for both and is
    // robust to duplicate/again events.)
    this._u.inputTokens = Math.max(this._u.inputTokens, found.inputTokens);
    this._u.outputTokens = Math.max(this._u.outputTokens, found.outputTokens);
    this._u.cacheReadTokens = Math.max(
      this._u.cacheReadTokens,
      found.cacheReadTokens,
    );
    this._u.cacheWriteTokens = Math.max(
      this._u.cacheWriteTokens,
      found.cacheWriteTokens,
    );
    if (found.model) this._u.model = found.model;
  }

  /**
   * Finalise. Call once the upstream stream has ended. If the stream was an
   * OpenAI-compatible one that never carried a usage chunk (caller did not
   * request include_usage), we CANNOT fabricate counts — mark incomplete so
   * the proxy can apply its configured incomplete-usage policy instead of
   * silently recording $0 (which would be an unsafe undercount).
   * @returns {Usage}
   */
  end() {
    // flush any final buffered event (last event may lack trailing blank).
    if (this._buf.trim() !== "") {
      this._consumeEvent(this._buf);
      this._buf = "";
    }
    if (!this._sawAnyUsage) this._u.incomplete = true;
    return { ...this._u };
  }
}

/**
 * Decide whether a response is streamed based on the upstream
 * Content-Type. Anthropic and OpenAI-compatible both use
 * `text/event-stream` for SSE.
 * @param {string|undefined} contentType
 * @returns {boolean}
 */
export function isStreamingContentType(contentType) {
  return /text\/event-stream/i.test(String(contentType || ""));
}
