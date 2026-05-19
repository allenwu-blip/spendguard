/**
 * proxy.js — the local guarding proxy.
 *
 * Data-flow / security model (this is the part that has to be right):
 *
 *   agent --> http://127.0.0.1:PORT/...  -->  spendguard  -->  upstream
 *
 *  1. The server binds a LOOPBACK address only (enforced in config.js;
 *     re-asserted here). It is never reachable off-box.
 *  2. The incoming request body is buffered ONLY to (a) measure its byte
 *     length and (b) re-send it upstream. Its CONTENT is never logged,
 *     persisted, or returned in diagnostics. The Authorization / x-api-key
 *     header is copied straight onto the upstream request and is NEVER
 *     read, logged, persisted, or echoed — it lives in memory for the
 *     duration of the forward and nothing else.
 *  3. BEFORE forwarding, the per-project ledger is consulted and
 *     enforce.evaluate() decides ALLOW / WARN / BLOCK. On a hard block the
 *     upstream is NEVER contacted — the agent gets a clear over-budget /
 *     runaway error and no money is spent.
 *  4. On ALLOW/WARN the request is forwarded. The upstream response is
 *     streamed straight back to the agent. As bytes pass through, a usage
 *     accumulator scans them for the API's own token-usage fields and then
 *     discards them — only token counts + model + the project tag are kept.
 *  5. Spend = tokens x the user's price table (an ESTIMATE) and is recorded
 *     to the per-project ledger, which the next request's check will see.
 *
 * Everything that could ever be emitted goes through src/redact.js. There
 * is intentionally no "debug mode" that dumps bodies — that would be the
 * exact footgun this product exists to avoid.
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { Ledger } from "./ledger.js";
import { buildPricing, priceFor, estimateCost } from "./pricing.js";
import {
  parseNonStreaming,
  StreamingUsageAccumulator,
  isStreamingContentType,
} from "./usage.js";
import { evaluate, DECISION } from "./enforce.js";
import { safeRequestMeta, scrubString } from "./redact.js";

const MAX_BODY_BYTES = 64 * 1024 * 1024; // refuse absurd bodies (DoS guard)

/**
 * Create (but do not start) the proxy. Returns { server, ledger, stop }.
 *
 * @param {object} config resolved config from resolveConfig()
 * @param {object} [deps] optional injectables for tests:
 *   - log(meta): receives ONLY redact.safeRequestMeta-shaped objects +
 *     strings already scrubbed. Default: no-op (the CLI supplies a
 *     stdout logger that is itself leak-tested).
 *   - now(): Date.now override
 *   - ledger: a pre-made Ledger (tests pass an in-memory one)
 */
export function createProxy(config, deps = {}) {
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const ledger =
    deps.ledger ||
    new Ledger({ statePath: config.statePath || null, windowMs: config.windowMs });
  const pricing = buildPricing(config.pricing);
  const upstream = new URL(config.upstreamBaseUrl);
  const upstreamClient = upstream.protocol === "https:" ? https : http;

  // Track projects whose last streamed call could not be accounted, so the
  // "block-next" incomplete-usage policy can act on it.
  const pendingIncomplete = new Set();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      // Never leak: scrub the error and emit only a generic shape.
      safeError(res, 502, "spendguard_upstream_error", scrubString(e && e.message));
      log({ event: "error", detail: scrubString(e && e.message) });
    });
  });

  async function handle(req, res) {
    // --- determine project tag (header wins, else default). The header
    // VALUE is a project label, not a secret; still scrubbed defensively.
    const project =
      scrubString(req.headers[config.projectHeader] || config.defaultProject)
        .slice(0, 128) || "default";

    // --- buffer the request body (bytes only; content never inspected) ---
    const chunks = [];
    let bytes = 0;
    let tooBig = false;
    for await (const c of req) {
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        tooBig = true;
        break;
      }
      chunks.push(c);
    }
    if (tooBig) {
      safeError(res, 413, "spendguard_body_too_large",
        `request body exceeds ${MAX_BODY_BYTES} bytes`);
      return;
    }
    const body = Buffer.concat(chunks);

    const meta = safeRequestMeta({
      method: req.method,
      path: req.url,
      project,
      bodyBytes: bytes,
    });

    // --- PRE-FORWARD ENFORCEMENT (the whole point) ---
    // Snapshot reflects calls ALREADY made (not this attempt yet) so the
    // decision is "is the project over budget / has it ALREADY made N calls
    // in the window". We touch() only AFTER deciding to forward, so a
    // blocked call never inflates the runaway counter and the runaway kill
    // means "the (maxCalls+1)-th call in the window is refused".
    const snap = ledger.snapshot(project, now());
    const decision = evaluate(snap, {
      budgetTotal: config.budgetTotal,
      budgetDaily: config.budgetDaily,
      overBudget: config.overBudget,
      maxCallsPerWindow: config.maxCallsPerWindow,
      windowMs: config.windowMs,
    });

    // incomplete-usage "block-next": if the last streamed call for this
    // project couldn't be accounted and policy is conservative, refuse the
    // next one until the user acknowledges (prevents silent runaway when
    // usage is invisible).
    if (
      config.incompleteUsage === "block-next" &&
      pendingIncomplete.has(project) &&
      decision.decision === DECISION.ALLOW
    ) {
      log({ ...meta, event: "block", decision: "BLOCK_INCOMPLETE" });
      safeError(
        res,
        429,
        "spendguard_incomplete_usage",
        `a previous streamed call for project "${project}" returned no ` +
          `usage spendguard could read, so its cost is unknown. ` +
          `incompleteUsage policy is "block-next": refusing further calls ` +
          `for this project until restarted/acknowledged. Set ` +
          `incompleteUsage:"count-zero" to forward anyway (logs the gap).`,
      );
      return;
    }

    if (
      decision.decision === DECISION.BLOCK_BUDGET ||
      decision.decision === DECISION.BLOCK_RUNAWAY
    ) {
      log({ ...meta, event: "block", decision: decision.decision });
      safeError(
        res,
        429,
        decision.decision === DECISION.BLOCK_RUNAWAY
          ? "spendguard_runaway_blocked"
          : "spendguard_budget_blocked",
        decision.reason,
        { project, scope: decision.scope, limit: decision.limit },
      );
      return;
    }

    // ALLOW or WARN -> forward. Count this attempt NOW (after the decision,
    // before the upstream call) for runaway-loop detection.
    ledger.touch(project, now());
    if (decision.decision === DECISION.WARN) {
      log({ ...meta, event: "warn", detail: decision.reason });
    }

    await forward(req, res, body, project, meta);
  }

  function forward(req, res, body, project, meta) {
    return new Promise((resolve) => {
      const target = joinUpstream(upstream, req.url);

      // Copy headers through UNTOUCHED (incl. the credential header). We do
      // not read or mutate the secret; we just set host and let it flow.
      const headers = { ...req.headers };
      headers.host = target.host;
      delete headers["content-length"]; // we resend a known-length buffer
      headers["content-length"] = Buffer.byteLength(body);

      const upReq = upstreamClient.request(
        target,
        { method: req.method, headers },
        (upRes) => {
          const ct = upRes.headers["content-type"];
          const streaming = isStreamingContentType(ct);
          // Mirror upstream status + headers verbatim to the agent.
          res.writeHead(upRes.statusCode || 502, upRes.headers);

          const acc = streaming ? new StreamingUsageAccumulator() : null;
          const nonStreamChunks = [];
          let respBytes = 0;

          upRes.on("data", (chunk) => {
            respBytes += chunk.length;
            // Pass the byte straight through to the agent FIRST.
            res.write(chunk);
            // Then scan ONLY for usage. For streaming, feed the
            // accumulator (it keeps no content). For non-streaming we must
            // see the whole JSON; we buffer it transiently, parse usage,
            // and drop it — capped so a huge body can't blow memory.
            if (streaming) {
              acc.push(chunk);
            } else if (respBytes <= MAX_BODY_BYTES) {
              nonStreamChunks.push(chunk);
            }
          });

          upRes.on("end", () => {
            let usage;
            if (streaming) {
              usage = acc.end();
            } else {
              usage = parseNonStreaming(Buffer.concat(nonStreamChunks));
              // free transient body immediately
              nonStreamChunks.length = 0;
            }
            // CRITICAL ordering: book the spend (synchronous ledger update
            // + atomic persist) BEFORE signalling end-of-response to the
            // agent. Otherwise an agent that immediately fires its next
            // request could have its pre-forward budget check run against a
            // ledger that has not yet recorded the call that just
            // completed — i.e. overspend could slip the guard under
            // back-to-back calls. account() is fully synchronous so this
            // adds negligible latency and closes that window.
            account(project, usage, meta, respBytes, streaming);
            res.end();
            resolve();
          });

          upRes.on("error", () => {
            try {
              res.end();
            } catch {}
            resolve();
          });
        },
      );

      upReq.setTimeout(config.requestTimeoutMs, () => {
        upReq.destroy(new Error("upstream timeout"));
      });

      upReq.on("error", (e) => {
        safeError(res, 502, "spendguard_upstream_error", scrubString(e.message));
        resolve();
      });

      upReq.end(body);
    });
  }

  function account(project, usage, meta, respBytes, streaming) {
    const model = usage.model || meta.model || "unknown";
    const price = priceFor(pricing, model);
    const cost = estimateCost(price, usage);
    ledger.record({
      project,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      cost,
      ts: now(),
      incomplete: usage.incomplete,
    });
    if (usage.incomplete) {
      pendingIncomplete.add(project);
    } else {
      pendingIncomplete.delete(project);
    }
    // log line carries ONLY accounting facts — no content, no headers.
    log({
      ...meta,
      event: "accounted",
      model: scrubString(model).slice(0, 128),
      streaming: Boolean(streaming),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estCostUsd: round6(cost),
      incompleteUsage: Boolean(usage.incomplete),
      respBytes,
    });
  }

  function stop() {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, ledger, stop, _pricing: pricing };
}

/**
 * Start the proxy listening. Re-asserts the loopback bind here as a second
 * line of defence (config.js already rejects non-loopback, but a proxy
 * holding API keys should never depend on a single check).
 *
 * @returns {Promise<{server:import('http').Server, ledger:Ledger, stop:Function, address:object}>}
 */
export function startProxy(config, deps = {}) {
  const LOOPBACK = new Set(["127.0.0.1", "::1"]);
  const host = config.host === "localhost" ? "127.0.0.1" : config.host;
  if (!LOOPBACK.has(host)) {
    return Promise.reject(
      new Error(
        `refusing to bind non-loopback host "${host}" — spendguard holds ` +
          `your upstream API key and must be localhost-only`,
      ),
    );
  }
  const built = createProxy(config, deps);
  return new Promise((resolve, reject) => {
    built.server.once("error", reject);
    built.server.listen(config.port, host, () => {
      built.server.removeListener("error", reject);
      resolve({ ...built, address: built.server.address() });
    });
  });
}

/**
 * Emit a structured, SAFE error to the agent. The detail string is scrubbed
 * for key-shaped substrings; we never put a header value or body in here.
 */
function safeError(res, status, code, detail, extra) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {}
    return;
  }
  const payload = {
    error: {
      type: code,
      source: "spendguard",
      message: scrubString(detail || code),
      ...(extra ? { spendguard: extra } : {}),
      note:
        "spendguard estimates token spend from your price table and is " +
        "not a billing system. See README limitations.",
    },
  };
  const buf = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": buf.length,
  });
  res.end(buf);
}

function round6(x) {
  return Math.round((Number(x) || 0) * 1e6) / 1e6;
}

/**
 * Join the configured upstream base URL (which MAY include a base path,
 * e.g. an enterprise gateway at https://gw.example/llm) with the incoming
 * request's path+query. Pure and exported for direct unit testing.
 *
 * Rules:
 *  - upstream base path (if any, and not just "/") is a PREFIX
 *  - the agent's request path is appended after it
 *  - the agent's query string is preserved
 * @param {URL} base
 * @param {string} reqUrl  e.g. "/v1/messages?beta=true"
 * @returns {URL}
 */
export function joinUpstream(base, reqUrl) {
  const out = new URL(base.toString());
  const qIdx = reqUrl.indexOf("?");
  const reqPath = qIdx === -1 ? reqUrl : reqUrl.slice(0, qIdx);
  const reqQuery = qIdx === -1 ? "" : reqUrl.slice(qIdx); // includes leading "?"
  const basePath =
    base.pathname && base.pathname !== "/"
      ? base.pathname.replace(/\/+$/, "")
      : "";
  const sep = reqPath.startsWith("/") ? "" : "/";
  out.pathname = basePath + sep + reqPath;
  out.search = reqQuery;
  return out;
}
