/**
 * client.js — minimal HTTP client (Node core only) to drive the proxy in
 * tests exactly like an agent would. Collects status, headers, and the full
 * (possibly streamed) body so assertions can check passthrough fidelity.
 */
import http from "node:http";

export function call(port, { method = "POST", path = "/v1/messages", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json", ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}
