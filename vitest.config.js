import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.js"],
    // Hard guarantee: NO external network and NO real API key.
    // Every test spins a LOCAL fake "upstream LLM" on 127.0.0.1 that
    // returns canned usage payloads. The proxy only ever connects to
    // that loopback fake. The suite itself asserts no key / no prompt
    // body is ever written to logs or disk (see test/no-leak.test.js).
    env: {},
    testTimeout: 15000,
  },
});
