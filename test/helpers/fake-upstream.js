/**
 * fake-upstream.js — a LOCAL fake "upstream LLM" on 127.0.0.1.
 *
 * The whole test suite runs against this; there is NO external network and
 * NO real API key anywhere. It returns canned usage payloads in the
 * Anthropic and OpenAI-compatible shapes, including a streaming (SSE) case,
 * and it RECORDS what it received (headers + body) so the no-leak test can
 * prove the proxy forwarded the key correctly to the upstream while NEVER
 * logging/persisting it.
 */

import http from "node:http";

/**
 * @param {(req, body, ctx) => {status?:number, headers?:object, body?:string, stream?:string[]}} responder
 * @returns {Promise<{url:string, port:number, received:Array, close:Function}>}
 */
export function startFakeUpstream(responder) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body,
      });
      const r = responder(req, body, { count: received.length }) || {};
      if (r.stream) {
        res.writeHead(r.status || 200, {
          "content-type": "text/event-stream",
          ...(r.headers || {}),
        });
        // emit SSE events with a tiny delay so it is a genuine stream
        let i = 0;
        const tick = () => {
          if (i >= r.stream.length) {
            res.end();
            return;
          }
          res.write(r.stream[i++]);
          setTimeout(tick, 2);
        };
        tick();
      } else {
        const payload = r.body != null ? r.body : "{}";
        res.writeHead(r.status || 200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...(r.headers || {}),
        });
        res.end(payload);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        received,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Canned Anthropic non-streaming response. */
export function anthropicJson({ model = "claude-3-5-sonnet-20241022", input = 1000, output = 500, cacheRead = 0, cacheWrite = 0 } = {}) {
  return JSON.stringify({
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "FAKE_ASSISTANT_REPLY_CONTENT" }],
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheWrite,
    },
  });
}

/** Canned OpenAI-compatible non-streaming response. */
export function openaiJson({ model = "gpt-4o", input = 800, output = 200 } = {}) {
  return JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "FAKE_OPENAI_REPLY" }, finish_reason: "stop" }],
    usage: { prompt_tokens: input, completion_tokens: output },
  });
}

/**
 * Canned Anthropic STREAMING (SSE) events. input_tokens at message_start,
 * output_tokens grows across message_delta events (cumulative) — the proxy
 * must end up with the FINAL output_tokens, not the first.
 */
export function anthropicStream({ model = "claude-3-5-sonnet-20241022", input = 1200, finalOutput = 900 } = {}) {
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_s", model, usage: { input_tokens: input, output_tokens: 1 } } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "FAKE_STREAM_CHUNK_1 " } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "FAKE_STREAM_CHUNK_2 " } })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: {}, usage: { output_tokens: Math.floor(finalOutput / 2) } })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: finalOutput } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ];
}

/** Canned OpenAI-compatible STREAMING with a terminal usage chunk. */
export function openaiStream({ model = "gpt-4o", input = 700, output = 350 } = {}) {
  return [
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model, choices: [{ delta: { content: "FAKE_OAI_STREAM_1" }, index: 0 }] })}\n\n`,
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model, choices: [{ delta: { content: "FAKE_OAI_STREAM_2" }, index: 0 }] })}\n\n`,
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model, choices: [{ delta: {}, index: 0, finish_reason: "stop" }], usage: { prompt_tokens: input, completion_tokens: output } })}\n\n`,
    `data: [DONE]\n\n`,
  ];
}

/** OpenAI-compatible STREAM that NEVER includes usage (include_usage off). */
export function openaiStreamNoUsage({ model = "gpt-4o" } = {}) {
  return [
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model, choices: [{ delta: { content: "NO_USAGE_CHUNK" }, index: 0 }] })}\n\n`,
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model, choices: [{ delta: {}, index: 0, finish_reason: "stop" }] })}\n\n`,
    `data: [DONE]\n\n`,
  ];
}
