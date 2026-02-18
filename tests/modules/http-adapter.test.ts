import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TargetConfig, TestInput } from "@apt/lib/types";
import { HttpAdapter } from "@apt/modules/introspector/adapters/http";

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let requestCount: number;

beforeAll(() => {
  requestCount = 0;
  server = Bun.serve({
    port: 0, // Random port
    fetch(req) {
      requestCount++;
      const url = new URL(req.url);

      // Route handling
      if (req.method === "HEAD") {
        return new Response(null, { status: 200 });
      }

      if (url.pathname === "/models") {
        return Response.json({ data: [{ id: "gpt-4" }] });
      }

      if (url.pathname === "/error-429") {
        return new Response("Rate limited", { status: 429 });
      }

      if (url.pathname === "/error-500") {
        return new Response("Server error", { status: 500 });
      }

      if (url.pathname === "/error-400") {
        return new Response("Bad request", { status: 400 });
      }

      if (url.pathname === "/error-401") {
        return new Response("Unauthorized", { status: 401 });
      }

      if (url.pathname === "/slow") {
        return new Promise((resolve) =>
          setTimeout(() => resolve(Response.json({ content: "slow" })), 3000),
        );
      }

      if (url.pathname === "/malformed") {
        return new Response("not json {{{", {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/openai") {
        return Response.json({
          choices: [{ message: { content: "Hello! How can I help?" } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        });
      }

      // Check auth headers
      if (url.pathname === "/check-auth") {
        const auth = req.headers.get("Authorization");
        const apiKey = req.headers.get("X-API-Key");
        const customKey = req.headers.get("X-Custom-Key");
        return Response.json({ auth, apiKey, customKey });
      }

      // Default: echo
      if (req.method === "POST") {
        return Response.json({ content: "Echo response" });
      }

      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: { Allow: "GET, POST, OPTIONS" },
        });
      }

      return Response.json({ content: "default" });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

// Helper to create a basic config
function makeConfig(overrides?: Partial<TargetConfig>): TargetConfig {
  return {
    url: baseUrl,
    adapter: "http",
    ...overrides,
  };
}

// Helper to create a basic test input
function makeInput(overrides?: Partial<TestInput>): TestInput {
  return {
    type: "text",
    content: "Hello, world!",
    ...overrides,
  };
}

// === 1. Connection basic (2 tests) ===
describe("Connection basic", () => {
  test("connects to a valid URL successfully", async () => {
    const adapter = new HttpAdapter();
    await expect(adapter.connect(makeConfig())).resolves.toBeUndefined();
    await adapter.disconnect();
  });

  test("adapter is usable after connect", async () => {
    const adapter = new HttpAdapter();
    await adapter.connect(makeConfig());
    const output = await adapter.send(makeInput());
    expect(output.content).toBe("Echo response");
    expect(output.format).toBe("json");
    expect(output.latency_ms).toBeGreaterThanOrEqual(0);
    await adapter.disconnect();
  });
});

// === 2. Auth Bearer (2 tests) ===
describe("Auth Bearer", () => {
  test("sends Bearer token in Authorization header", async () => {
    const adapter = new HttpAdapter();
    await adapter.connect(
      makeConfig({
        url: `${baseUrl}/check-auth`,
        auth: { type: "bearer", token: "my-secret-token" },
      }),
    );
    const output = await adapter.send(makeInput());
    const parsed = JSON.parse(output.content);
    expect(parsed.auth).toBe("Bearer my-secret-token");
    await adapter.disconnect();
  });

  test("Bearer token verified via /check-auth endpoint", async () => {
    const adapter = new HttpAdapter();
    await adapter.connect(
      makeConfig({
        url: `${baseUrl}/check-auth`,
        auth: { type: "bearer", token: "another-token" },
      }),
    );
    const output = await adapter.send(makeInput());
    const parsed = JSON.parse(output.content);
    expect(parsed.auth).toContain("Bearer");
    expect(parsed.auth).toContain("another-token");
    await adapter.disconnect();
  });
});

// === 3. Auth API-key (2 tests) ===
describe("Auth API-key", () => {
  test("sends API key in default X-API-Key header", async () => {
    const adapter = new HttpAdapter();
    await adapter.connect(
      makeConfig({
        url: `${baseUrl}/check-auth`,
        auth: { type: "api-key", token: "key-12345" },
      }),
    );
    const output = await adapter.send(makeInput());
    const parsed = JSON.parse(output.content);
    expect(parsed.apiKey).toBe("key-12345");
    await adapter.disconnect();
  });

  test("sends API key in custom header name", async () => {
    const adapter = new HttpAdapter();
    await adapter.connect(
      makeConfig({
        url: `${baseUrl}/check-auth`,
        auth: { type: "api-key", token: "key-67890", header: "X-Custom-Key" },
      }),
    );
    const output = await adapter.send(makeInput());
    const parsed = JSON.parse(output.content);
    expect(parsed.customKey).toBe("key-67890");
    await adapter.disconnect();
  });
});

// === 4. Timeout (2 tests) ===
describe("Timeout", () => {
  test("timeout triggers on slow endpoint", async () => {
    const adapter = new HttpAdapter();
    await adapter.connect(
      makeConfig({
        url: `${baseUrl}/slow`,
        timeout_ms: 100,
      }),
    );
    try {
      await adapter.send(makeInput());
      expect(true).toBe(false); // Should not reach here
    } catch (error: unknown) {
      const err = error as { moduleError?: { code: string } };
      expect(err.moduleError?.code).toBe("INTRO_TIMEOUT_001");
    }
    await adapter.disconnect();
  });

  test("timeout error message includes timeout duration", async () => {
    const adapter = new HttpAdapter();
    await adapter.connect(
      makeConfig({
        url: `${baseUrl}/slow`,
        timeout_ms: 150,
      }),
    );
    try {
      await adapter.send(makeInput());
      expect(true).toBe(false);
    } catch (error: unknown) {
      const err = error as { message: string; moduleError?: { recoverable: boolean } };
      expect(err.message).toContain("150ms");
      expect(err.moduleError?.recoverable).toBe(true);
    }
    await adapter.disconnect();
  });
});

// === 5. Retry on 429 (2 tests) ===
describe("Retry on 429", () => {
  test("retries on 429 status code", async () => {
    const adapter = new HttpAdapter();
    await adapter.connect(
      makeConfig({
        url: `${baseUrl}/error-429`,
        timeout_ms: 60000,
      }),
    );
    const countBefore = requestCount;
    try {
      await adapter.send(makeInput());
      expect(true).toBe(false);
    } catch (error: unknown) {
      const err = error as { moduleError?: { code: string } };
      // Should have made multiple requests (initial + retries)
      const requestsMade = requestCount - countBefore;
      expect(requestsMade).toBeGreaterThan(1);
      expect(err.moduleError?.code).toBe("INTRO_SEND_001");
    }
    await adapter.disconnect();
  }, 30000);

  test("eventually fails after max retries on 429", async () => {
    const adapter = new HttpAdapter();
    await adapter.connect(
      makeConfig({
        url: `${baseUrl}/error-429`,
        timeout_ms: 60000,
      }),
    );
    try {
      await adapter.send(makeInput());
      expect(true).toBe(false);
    } catch (error: unknown) {
      const err = error as { moduleError?: { recoverable: boolean } };
      expect(err.moduleError?.recoverable).toBe(true);
    }
    await adapter.disconnect();
  }, 30000);
});

// === 6. Retry on 500 (1 test) ===
describe("Retry on 500", () => {
  test("retries on 500 server error", async () => {
    const adapter = new HttpAdapter();
    await adapter.connect(
      makeConfig({
        url: `${baseUrl}/error-500`,
        timeout_ms: 60000,
      }),
    );
    const countBefore = requestCount;
    try {
      await adapter.send(makeInput());
      expect(true).toBe(false);
    } catch {
      const requestsMade = requestCount - countBefore;
      // Should have retried: initial + 3 retries = 4 POST requests
      expect(requestsMade).toBeGreaterThan(1);
    }
    await adapter.disconnect();
  }, 30000);
});

// === 7. No retry on 400 (1 test) ===
describe("No retry on 400", () => {
  test("does not retry on 400 bad request", async () => {
    const adapter = new HttpAdapter();
    await adapter.connect(
      makeConfig({
        url: `${baseUrl}/error-400`,
      }),
    );
    const countBefore = requestCount;
    try {
      await adapter.send(makeInput());
      expect(true).toBe(false);
    } catch (error: unknown) {
      const err = error as { moduleError?: { code: string } };
      const requestsMade = requestCount - countBefore;
      // Should have made exactly 1 POST request (no retries)
      expect(requestsMade).toBe(1);
      expect(err.moduleError?.code).toBe("INTRO_SEND_001");
    }
    await adapter.disconnect();
  });
});

// === 8. No retry on 401 (1 test) ===
describe("No retry on 401", () => {
  test("does not retry on 401 unauthorized", async () => {
    const adapter = new HttpAdapter();
    await adapter.connect(
      makeConfig({
        url: `${baseUrl}/error-401`,
      }),
    );
    const countBefore = requestCount;
    try {
      await adapter.send(makeInput());
      expect(true).toBe(false);
    } catch (error: unknown) {
      const err = error as { moduleError?: { code: string; recoverable: boolean } };
      const requestsMade = requestCount - countBefore;
      expect(requestsMade).toBe(1);
      expect(err.moduleError?.code).toBe("INTRO_SEND_001");
      expect(err.moduleError?.recoverable).toBe(false);
    }
    await adapter.disconnect();
  });
});

// === 9. Env var expansion (2 tests) ===
describe("Env var expansion", () => {
  test("${VAR} in URL is expanded from env", async () => {
    const originalPort = server.port;
    process.env.TEST_APT_PORT = String(originalPort);

    const adapter = new HttpAdapter();
    await adapter.connect(
      makeConfig({
        url: "http://localhost:${TEST_APT_PORT}",
      }),
    );
    const output = await adapter.send(makeInput());
    expect(output.content).toBe("Echo response");
    await adapter.disconnect();

    process.env.TEST_APT_PORT = undefined;
  });

  test("${VAR} in token is expanded from env", async () => {
    process.env.TEST_APT_TOKEN = "expanded-secret";

    const adapter = new HttpAdapter();
    await adapter.connect(
      makeConfig({
        url: `${baseUrl}/check-auth`,
        auth: { type: "bearer", token: "${TEST_APT_TOKEN}" },
      }),
    );
    const output = await adapter.send(makeInput());
    const parsed = JSON.parse(output.content);
    expect(parsed.auth).toBe("Bearer expanded-secret");
    await adapter.disconnect();

    process.env.TEST_APT_TOKEN = undefined;
  });
});

// === 10. inspect() OpenAI detection (2 tests) ===
describe("inspect() OpenAI detection", () => {
  test("detects OpenAI-compatible provider via /models", async () => {
    const adapter = new HttpAdapter();
    await adapter.connect(makeConfig());
    const metadata = await adapter.inspect();
    expect(metadata.reachable).toBe(true);
    expect(metadata.detected_provider).toBe("openai-compatible");
    expect(metadata.response_format).toBe("openai");
    await adapter.disconnect();
  });

  test("returns headers from OPTIONS request", async () => {
    const adapter = new HttpAdapter();
    await adapter.connect(makeConfig());
    const metadata = await adapter.inspect();
    expect(metadata.headers).toBeDefined();
    expect(metadata.headers?.allow).toBe("GET, POST, OPTIONS");
    await adapter.disconnect();
  });
});

// === 11. Connection refused (1 test) ===
describe("Connection refused", () => {
  test("connection to invalid port throws recoverable error", async () => {
    const adapter = new HttpAdapter();
    try {
      await adapter.connect(
        makeConfig({
          url: "http://localhost:19999",
        }),
      );
      expect(true).toBe(false);
    } catch (error: unknown) {
      const err = error as { moduleError?: { code: string; recoverable: boolean } };
      expect(err.moduleError?.code).toBe("INTRO_CONN_001");
      expect(err.moduleError?.recoverable).toBe(true);
    }
  });
});

// === 12. JSON malformed (1 test) ===
describe("JSON malformed", () => {
  test("malformed JSON response throws parse error", async () => {
    const adapter = new HttpAdapter();
    await adapter.connect(
      makeConfig({
        url: `${baseUrl}/malformed`,
      }),
    );
    try {
      await adapter.send(makeInput());
      expect(true).toBe(false);
    } catch (error: unknown) {
      const err = error as { moduleError?: { code: string; recoverable: boolean } };
      expect(err.moduleError?.code).toBe("INTRO_PARSE_001");
      expect(err.moduleError?.recoverable).toBe(false);
    }
    await adapter.disconnect();
  });
});

// === 13. Latency measurement (1 test) ===
describe("Latency measurement", () => {
  test("latency is measured within tolerance", async () => {
    const adapter = new HttpAdapter();
    await adapter.connect(makeConfig());
    const output = await adapter.send(makeInput());
    // Latency should be a positive number (local server, so very fast)
    expect(output.latency_ms).toBeGreaterThanOrEqual(0);
    // Local requests should be under 100ms
    expect(output.latency_ms).toBeLessThan(100);
    await adapter.disconnect();
  });
});

// === 14. OpenAI format parsing ===
describe("OpenAI format parsing", () => {
  test("parses OpenAI-compatible response format", async () => {
    const adapter = new HttpAdapter();
    await adapter.connect(
      makeConfig({
        url: `${baseUrl}/openai`,
      }),
    );
    const output = await adapter.send(makeInput());
    expect(output.content).toBe("Hello! How can I help?");
    expect(output.format).toBe("json");
    await adapter.disconnect();
  });
});

// === 15. Disconnect behavior ===
describe("Disconnect", () => {
  test("send() throws after disconnect", async () => {
    const adapter = new HttpAdapter();
    await adapter.connect(makeConfig());
    await adapter.disconnect();
    try {
      await adapter.send(makeInput());
      expect(true).toBe(false);
    } catch (error: unknown) {
      const err = error as { moduleError?: { code: string } };
      expect(err.moduleError?.code).toBe("INTRO_CONN_001");
    }
  });

  test("inspect() throws after disconnect", async () => {
    const adapter = new HttpAdapter();
    await adapter.connect(makeConfig());
    await adapter.disconnect();
    try {
      await adapter.inspect();
      expect(true).toBe(false);
    } catch (error: unknown) {
      const err = error as { moduleError?: { code: string } };
      expect(err.moduleError?.code).toBe("INTRO_CONN_001");
    }
  });
});
