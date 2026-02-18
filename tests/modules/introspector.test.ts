import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@apt/core/event-bus";
import type {
  Detector,
  SystemAdapter,
  SystemMetadata,
  SystemOutput,
  TargetConfig,
  TestInput,
} from "@apt/lib/types";
import { ConfigFileDetector } from "@apt/modules/introspector/detectors/config-file";
import { DependencyDetector } from "@apt/modules/introspector/detectors/dependency";
import { EndpointDetector } from "@apt/modules/introspector/detectors/endpoint";
import { IOProbingDetector } from "@apt/modules/introspector/detectors/io-probing";
import { Introspector } from "@apt/modules/introspector/index";

// ============================================================
// Mock servers
// ============================================================

/** OpenAI-compatible chatbot server */
let chatbotServer: ReturnType<typeof Bun.serve>;
let chatbotUrl: string;

/** RAG server returning sources */
let ragServer: ReturnType<typeof Bun.serve>;
let ragUrl: string;

/** Classifier server returning labels */
let classifierServer: ReturnType<typeof Bun.serve>;
let classifierUrl: string;

/** Agent server returning actions */
let agentServer: ReturnType<typeof Bun.serve>;
let agentUrl: string;

/** Deterministic server (always same response) */
let deterministicServer: ReturnType<typeof Bun.serve>;
let deterministicUrl: string;

/** Baseline server for latency/determinism tests */
let baselineServer: ReturnType<typeof Bun.serve>;
let baselineUrl: string;

beforeAll(() => {
  chatbotServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "HEAD") return new Response(null, { status: 200 });
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: { Allow: "GET, POST, OPTIONS" },
        });
      }
      if (url.pathname === "/models") {
        return Response.json({ data: [{ id: "gpt-4" }] });
      }
      if (req.method === "POST") {
        return Response.json({
          choices: [
            { message: { content: "Hello! I am a helpful assistant. How can I help you today?" } },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        });
      }
      return Response.json({ content: "default" });
    },
  });
  chatbotUrl = `http://localhost:${chatbotServer.port}`;

  ragServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "HEAD") return new Response(null, { status: 200 });
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });
      if (url.pathname === "/models") return new Response("Not found", { status: 404 });
      if (req.method === "POST") {
        return Response.json({
          content: "Paris is the capital of France.",
          sources: [{ title: "Wikipedia", url: "https://en.wikipedia.org/wiki/Paris" }],
          documents: [{ id: "doc-1", text: "Paris is the capital..." }],
        });
      }
      return Response.json({ content: "default" });
    },
  });
  ragUrl = `http://localhost:${ragServer.port}`;

  classifierServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "HEAD") return new Response(null, { status: 200 });
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });
      if (url.pathname === "/models") return new Response("Not found", { status: 404 });
      if (req.method === "POST") {
        return Response.json({
          label: "positive",
          class: "sentiment",
          prediction: 0.95,
        });
      }
      return Response.json({ content: "default" });
    },
  });
  classifierUrl = `http://localhost:${classifierServer.port}`;

  agentServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "HEAD") return new Response(null, { status: 200 });
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });
      if (url.pathname === "/models") return new Response("Not found", { status: 404 });
      if (req.method === "POST") {
        return Response.json({
          actions: [{ type: "search", query: "X" }],
          tools: ["search", "summarize"],
          steps: [
            { step: 1, action: "search", result: "found data" },
            { step: 2, action: "summarize", result: "summary" },
          ],
        });
      }
      return Response.json({ content: "default" });
    },
  });
  agentUrl = `http://localhost:${agentServer.port}`;

  deterministicServer = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.method === "HEAD") return new Response(null, { status: 200 });
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });
      if (req.method === "POST") {
        return Response.json({
          label: "positive",
          prediction: 0.95,
        });
      }
      return Response.json({ content: "default" });
    },
  });
  deterministicUrl = `http://localhost:${deterministicServer.port}`;

  baselineServer = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.method === "HEAD") return new Response(null, { status: 200 });
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });
      if (req.method === "POST") {
        return Response.json({ content: "baseline-response" });
      }
      return Response.json({ content: "default" });
    },
  });
  baselineUrl = `http://localhost:${baselineServer.port}`;
});

afterAll(() => {
  chatbotServer.stop(true);
  ragServer.stop(true);
  classifierServer.stop(true);
  agentServer.stop(true);
  deterministicServer.stop(true);
  baselineServer.stop(true);
});

// ============================================================
// Helpers
// ============================================================

function makeConfig(url: string, overrides?: Partial<TargetConfig>): TargetConfig {
  return { url, adapter: "http", ...overrides };
}

/** Create a simple adapter that wraps fetch for a given base URL */
function createMockAdapter(baseUrl: string): SystemAdapter {
  let connected = false;
  return {
    id: "test-http",
    type: "http",
    async connect(_config: TargetConfig) {
      connected = true;
    },
    async send(input: TestInput): Promise<SystemOutput> {
      if (!connected) throw new Error("Not connected");
      const start = performance.now();
      const resp = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: input.content }] }),
      });
      const latency = performance.now() - start;
      const json = await resp.json();
      const contentType = resp.headers.get("content-type") ?? "";
      return {
        content: JSON.stringify(json),
        format: contentType.includes("json") ? "json" : "text",
        latency_ms: Math.round(latency),
        metadata: {
          status: resp.status,
          headers: Object.fromEntries(resp.headers.entries()),
        },
      };
    },
    async inspect(): Promise<SystemMetadata> {
      const metadata: SystemMetadata = { reachable: true };
      try {
        const modelsUrl = new URL("/models", baseUrl).toString();
        const resp = await fetch(modelsUrl, { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          const json = await resp.json();
          if (json.data || json.models) {
            metadata.detected_provider = "openai-compatible";
            metadata.response_format = "openai";
          }
        }
      } catch {
        // not available
      }
      try {
        const resp = await fetch(baseUrl, {
          method: "OPTIONS",
          signal: AbortSignal.timeout(3000),
        });
        metadata.headers = Object.fromEntries(resp.headers.entries());
      } catch {
        // ignore
      }
      return metadata;
    },
    async disconnect() {
      connected = false;
    },
  };
}

// ============================================================
// 1. EndpointDetector tests
// ============================================================

describe("EndpointDetector", () => {
  test("detects OpenAI-compatible system as chatbot", async () => {
    const detector = new EndpointDetector();
    const adapter = createMockAdapter(chatbotUrl);
    await adapter.connect(makeConfig(chatbotUrl));
    const result = await detector.detect(makeConfig(chatbotUrl), {
      target: makeConfig(chatbotUrl),
      partialResults: [],
      adapter,
    });
    expect(result.system_type).toBe("chatbot");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    await adapter.disconnect();
  });

  test("OpenAI-compat has openai_compatible evidence", async () => {
    const detector = new EndpointDetector();
    const adapter = createMockAdapter(chatbotUrl);
    await adapter.connect(makeConfig(chatbotUrl));
    const result = await detector.detect(makeConfig(chatbotUrl), {
      target: makeConfig(chatbotUrl),
      partialResults: [],
      adapter,
    });
    expect(result.evidence.openai_compatible).toBe(true);
    await adapter.disconnect();
  });

  test("detects RAG system from response with sources", async () => {
    const detector = new EndpointDetector();
    const adapter = createMockAdapter(ragUrl);
    await adapter.connect(makeConfig(ragUrl));
    const result = await detector.detect(makeConfig(ragUrl), {
      target: makeConfig(ragUrl),
      partialResults: [],
      adapter,
    });
    expect(result.system_type).toBe("rag");
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    await adapter.disconnect();
  });

  test("RAG detection has rag_sources evidence", async () => {
    const detector = new EndpointDetector();
    const adapter = createMockAdapter(ragUrl);
    await adapter.connect(makeConfig(ragUrl));
    const result = await detector.detect(makeConfig(ragUrl), {
      target: makeConfig(ragUrl),
      partialResults: [],
      adapter,
    });
    expect(result.evidence.rag_sources).toBe(true);
    await adapter.disconnect();
  });

  test("detects classifier from response with label", async () => {
    const detector = new EndpointDetector();
    const adapter = createMockAdapter(classifierUrl);
    await adapter.connect(makeConfig(classifierUrl));
    const result = await detector.detect(makeConfig(classifierUrl), {
      target: makeConfig(classifierUrl),
      partialResults: [],
      adapter,
    });
    expect(result.system_type).toBe("classifier");
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    await adapter.disconnect();
  });

  test("classifier detection has classifier_output evidence", async () => {
    const detector = new EndpointDetector();
    const adapter = createMockAdapter(classifierUrl);
    await adapter.connect(makeConfig(classifierUrl));
    const result = await detector.detect(makeConfig(classifierUrl), {
      target: makeConfig(classifierUrl),
      partialResults: [],
      adapter,
    });
    expect(result.evidence.classifier_output).toBe(true);
    await adapter.disconnect();
  });

  test("detects agent from response with actions", async () => {
    const detector = new EndpointDetector();
    const adapter = createMockAdapter(agentUrl);
    await adapter.connect(makeConfig(agentUrl));
    const result = await detector.detect(makeConfig(agentUrl), {
      target: makeConfig(agentUrl),
      partialResults: [],
      adapter,
    });
    expect(result.system_type).toBe("agent");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    await adapter.disconnect();
  });

  test("returns null system_type when no adapter", async () => {
    const detector = new EndpointDetector();
    const result = await detector.detect(makeConfig(chatbotUrl), {
      target: makeConfig(chatbotUrl),
      partialResults: [],
    });
    expect(result.system_type).toBeNull();
    expect(result.confidence).toBe(0);
  });
});

// ============================================================
// 2. IOProbingDetector tests
// ============================================================

describe("IOProbingDetector", () => {
  test("conversational response detected as chatbot", async () => {
    const detector = new IOProbingDetector();
    const adapter = createMockAdapter(chatbotUrl);
    await adapter.connect(makeConfig(chatbotUrl));
    const result = await detector.detect(makeConfig(chatbotUrl), {
      target: makeConfig(chatbotUrl),
      partialResults: [],
      adapter,
    });
    // Chatbot server responds with conversational text containing "Hello"/"help"
    expect(result.system_type).toBe("chatbot");
    expect(result.confidence).toBeGreaterThan(0);
    await adapter.disconnect();
  });

  test("chatbot detection includes conversational evidence", async () => {
    const detector = new IOProbingDetector();
    const adapter = createMockAdapter(chatbotUrl);
    await adapter.connect(makeConfig(chatbotUrl));
    const result = await detector.detect(makeConfig(chatbotUrl), {
      target: makeConfig(chatbotUrl),
      partialResults: [],
      adapter,
    });
    expect(result.evidence.conversational_response).toBe(true);
    await adapter.disconnect();
  });

  test("high determinism boosts classifier score", async () => {
    const detector = new IOProbingDetector();
    const adapter = createMockAdapter(deterministicUrl);
    await adapter.connect(makeConfig(deterministicUrl));
    const result = await detector.detect(makeConfig(deterministicUrl), {
      target: makeConfig(deterministicUrl),
      partialResults: [],
      adapter,
    });
    expect(result.evidence.high_determinism).toBe(true);
    const scores = result.evidence.scores as Record<string, number>;
    expect(scores.classifier).toBeGreaterThan(0);
    await adapter.disconnect();
  });

  test("sources in response detected as RAG", async () => {
    const detector = new IOProbingDetector();
    const adapter = createMockAdapter(ragUrl);
    await adapter.connect(makeConfig(ragUrl));
    const result = await detector.detect(makeConfig(ragUrl), {
      target: makeConfig(ragUrl),
      partialResults: [],
      adapter,
    });
    expect(result.evidence.rag_structured_sources).toBe(true);
    const scores = result.evidence.scores as Record<string, number>;
    expect(scores.rag).toBeGreaterThan(0);
    await adapter.disconnect();
  });
});

// ============================================================
// 3. ConfigFileDetector tests
// ============================================================

describe("ConfigFileDetector", () => {
  test("detects langchain config as RAG", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "apt-cfg-"));
    try {
      // Create a langchain config file
      await Bun.write(join(tmpDir, "langchain.yaml"), "vectorstore: chroma\nllm: openai");

      const detector = new ConfigFileDetector(tmpDir);
      const result = await detector.detect(makeConfig("http://localhost"), {
        target: makeConfig("http://localhost"),
        partialResults: [],
      });
      expect(result.system_type).toBe("rag");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  test("returns null when no relevant files found", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "apt-cfg-empty-"));
    try {
      // Create an irrelevant file
      await Bun.write(join(tmpDir, "readme.txt"), "nothing relevant here");

      const detector = new ConfigFileDetector(tmpDir);
      const result = await detector.detect(makeConfig("http://localhost"), {
        target: makeConfig("http://localhost"),
        partialResults: [],
      });
      expect(result.system_type).toBeNull();
      expect(result.confidence).toBe(0);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  test("detects docker-compose with chromadb as RAG", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "apt-cfg-docker-"));
    try {
      await Bun.write(
        join(tmpDir, "docker-compose.yml"),
        "services:\n  vectordb:\n    image: chromadb/chroma\n    ports:\n      - 8000:8000",
      );

      const detector = new ConfigFileDetector(tmpDir);
      const result = await detector.detect(makeConfig("http://localhost"), {
        target: makeConfig("http://localhost"),
        partialResults: [],
      });
      expect(result.system_type).toBe("rag");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });
});

// ============================================================
// 4. DependencyDetector tests
// ============================================================

describe("DependencyDetector", () => {
  test("detects openai in package.json as chatbot", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "apt-dep-"));
    try {
      await Bun.write(
        join(tmpDir, "package.json"),
        JSON.stringify({
          name: "test-app",
          dependencies: { openai: "^4.0.0", express: "^4.18.0" },
        }),
      );

      const detector = new DependencyDetector(tmpDir);
      const result = await detector.detect(makeConfig("http://localhost"), {
        target: makeConfig("http://localhost"),
        partialResults: [],
      });
      expect(result.system_type).toBe("chatbot");
      expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  test("detects scikit-learn in requirements.txt as classifier", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "apt-dep-py-"));
    try {
      await Bun.write(
        join(tmpDir, "requirements.txt"),
        "scikit-learn==1.3.0\nnumpy==1.25.0\nfastapi==0.100.0",
      );

      const detector = new DependencyDetector(tmpDir);
      const result = await detector.detect(makeConfig("http://localhost"), {
        target: makeConfig("http://localhost"),
        partialResults: [],
      });
      expect(result.system_type).toBe("classifier");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  test("returns null when no dependency files found", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "apt-dep-empty-"));
    try {
      await Bun.write(join(tmpDir, "readme.md"), "# no deps here");

      const detector = new DependencyDetector(tmpDir);
      const result = await detector.detect(makeConfig("http://localhost"), {
        target: makeConfig("http://localhost"),
        partialResults: [],
      });
      expect(result.system_type).toBeNull();
      expect(result.confidence).toBe(0);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  test("detects langchain in requirements as RAG", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "apt-dep-rag-"));
    try {
      await Bun.write(
        join(tmpDir, "requirements.txt"),
        "langchain==0.1.0\nchromadb==0.4.0\nopenai==1.0.0",
      );

      const detector = new DependencyDetector(tmpDir);
      const result = await detector.detect(makeConfig("http://localhost"), {
        target: makeConfig("http://localhost"),
        partialResults: [],
      });
      expect(result.system_type).toBe("rag");
      // langchain (0.7) + chromadb (0.15) = 0.85 for RAG vs openai (0.6) for chatbot
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });
});

// ============================================================
// 5. Cascade (Introspector) tests
// ============================================================

describe("Cascade", () => {
  test("explicit system_type bypasses all detectors", async () => {
    const bus = new EventBus();
    const adapter = createMockAdapter(chatbotUrl);
    await adapter.connect(makeConfig(chatbotUrl));

    let detectorCalled = false;
    const fakeDetector: Detector = {
      name: "fake",
      priority: 1,
      async detect() {
        detectorCalled = true;
        return { system_type: "rag", confidence: 0.9, evidence: {} };
      },
    };

    const introspector = new Introspector([fakeDetector], adapter, bus);
    const profile = await introspector.profile(
      makeConfig(chatbotUrl, { system_type: "classifier" }),
    );

    expect(profile.system_type).toBe("classifier");
    expect(profile.detection_confidence).toBe(1.0);
    expect(detectorCalled).toBe(false);
    await adapter.disconnect();
  });

  test("unanimous vote results in high confidence", async () => {
    const bus = new EventBus();
    const adapter = createMockAdapter(chatbotUrl);
    await adapter.connect(makeConfig(chatbotUrl));

    const detector1: Detector = {
      name: "d1",
      priority: 10,
      async detect() {
        return { system_type: "rag", confidence: 0.8, evidence: {} };
      },
    };
    const detector2: Detector = {
      name: "d2",
      priority: 20,
      async detect() {
        return { system_type: "rag", confidence: 0.7, evidence: {} };
      },
    };

    const introspector = new Introspector([detector1, detector2], adapter, bus);
    const profile = await introspector.profile(makeConfig(chatbotUrl, { system_type: "auto" }));

    expect(profile.system_type).toBe("rag");
    // Unanimous -> max of confidences (0.8)
    expect(profile.detection_confidence).toBeGreaterThanOrEqual(0.8);
    await adapter.disconnect();
  });

  test("conflicting votes result in reduced confidence", async () => {
    const bus = new EventBus();
    const adapter = createMockAdapter(chatbotUrl);
    await adapter.connect(makeConfig(chatbotUrl));

    const detector1: Detector = {
      name: "d1",
      priority: 10,
      async detect() {
        return { system_type: "rag", confidence: 0.7, evidence: {} };
      },
    };
    const detector2: Detector = {
      name: "d2",
      priority: 20,
      async detect() {
        return { system_type: "chatbot", confidence: 0.6, evidence: {} };
      },
    };

    const introspector = new Introspector([detector1, detector2], adapter, bus);
    const profile = await introspector.profile(makeConfig(chatbotUrl, { system_type: "auto" }));

    // Top type should win but with reduced confidence compared to unanimous case
    expect(profile.system_type).toBe("rag");
    expect(profile.detection_confidence).toBeLessThan(0.8);
    await adapter.disconnect();
  });

  test("detector failure emits warning and continues", async () => {
    const bus = new EventBus();
    const adapter = createMockAdapter(chatbotUrl);
    await adapter.connect(makeConfig(chatbotUrl));

    const warnings: string[] = [];
    bus.on("pipeline.failed", (data) => {
      if (data.error.severity === "warning") {
        warnings.push(data.error.message);
      }
    });

    const failingDetector: Detector = {
      name: "failing",
      priority: 1,
      async detect() {
        throw new Error("Detector exploded");
      },
    };
    const goodDetector: Detector = {
      name: "good",
      priority: 10,
      async detect() {
        return { system_type: "chatbot", confidence: 0.8, evidence: {} };
      },
    };

    const introspector = new Introspector([failingDetector, goodDetector], adapter, bus);
    const profile = await introspector.profile(makeConfig(chatbotUrl, { system_type: "auto" }));

    // Should still produce a result from the good detector
    expect(profile.system_type).toBe("chatbot");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("failing");
    expect(warnings[0]).toContain("Detector exploded");
    await adapter.disconnect();
  });

  test("no detector results defaults to chatbot with 0.5 confidence", async () => {
    const bus = new EventBus();
    const adapter = createMockAdapter(chatbotUrl);
    await adapter.connect(makeConfig(chatbotUrl));

    const nullDetector: Detector = {
      name: "null",
      priority: 10,
      async detect() {
        return { system_type: null, confidence: 0, evidence: {} };
      },
    };

    const introspector = new Introspector([nullDetector], adapter, bus);
    const profile = await introspector.profile(makeConfig(chatbotUrl, { system_type: "auto" }));

    expect(profile.system_type).toBe("chatbot");
    expect(profile.detection_confidence).toBe(0.5);
    await adapter.disconnect();
  });
});

// ============================================================
// 6. Baseline tests
// ============================================================

describe("Baseline", () => {
  test("p50/p95/p99 latencies are calculated", async () => {
    const bus = new EventBus();
    const adapter = createMockAdapter(baselineUrl);
    await adapter.connect(makeConfig(baselineUrl));

    // Use an instant detector so we get to baseline quickly
    const fastDetector: Detector = {
      name: "fast",
      priority: 1,
      async detect() {
        return { system_type: "chatbot", confidence: 0.8, evidence: {} };
      },
    };

    const introspector = new Introspector([fastDetector], adapter, bus);
    const profile = await introspector.profile(makeConfig(baselineUrl, { system_type: "auto" }));

    expect(profile.baseline_metrics).toBeDefined();
    const bm = profile.baseline_metrics;
    if (!bm) throw new Error("baseline_metrics should be defined");
    expect(bm.latency_p50).toBeGreaterThanOrEqual(0);
    expect(bm.latency_p95).toBeGreaterThanOrEqual(bm.latency_p50);
    expect(bm.latency_p99).toBeGreaterThanOrEqual(bm.latency_p95);
    await adapter.disconnect();
  }, 30000);

  test("determinism is measured", async () => {
    const bus = new EventBus();
    const adapter = createMockAdapter(baselineUrl);
    await adapter.connect(makeConfig(baselineUrl));

    const fastDetector: Detector = {
      name: "fast",
      priority: 1,
      async detect() {
        return { system_type: "chatbot", confidence: 0.8, evidence: {} };
      },
    };

    const introspector = new Introspector([fastDetector], adapter, bus);
    const profile = await introspector.profile(makeConfig(baselineUrl, { system_type: "auto" }));

    expect(profile.baseline_metrics).toBeDefined();
    const bm = profile.baseline_metrics;
    if (!bm) throw new Error("baseline_metrics should be defined");
    // Deterministic server -> determinism should be 1.0
    expect(bm.determinism).toBe(1);
    await adapter.disconnect();
  }, 30000);
});

// ============================================================
// 7. Profile completeness
// ============================================================

describe("Profile", () => {
  test("complete profile has all required fields", async () => {
    const bus = new EventBus();
    const adapter = createMockAdapter(chatbotUrl);
    await adapter.connect(makeConfig(chatbotUrl));

    const detector: Detector = {
      name: "test",
      priority: 10,
      async detect() {
        return { system_type: "chatbot", confidence: 0.8, evidence: { test: true } };
      },
    };

    const introspector = new Introspector([detector], adapter, bus);
    const profile = await introspector.profile(makeConfig(chatbotUrl, { system_type: "auto" }));

    // Check all SystemProfile fields
    expect(profile.id).toBeTruthy();
    expect(profile.id).toContain("profile-");
    expect(profile.detected_at).toBeTruthy();
    expect(new Date(profile.detected_at).getTime()).toBeGreaterThan(0);
    expect(profile.system_type).toBe("chatbot");
    expect(profile.detection_confidence).toBeGreaterThan(0);
    expect(profile.detection_methods).toBeInstanceOf(Array);
    expect(profile.detection_methods.length).toBe(1);
    expect(profile.detection_methods[0].method).toBe("test");
    expect(profile.input_interfaces).toBeInstanceOf(Array);
    expect(profile.input_interfaces.length).toBeGreaterThan(0);
    expect(profile.output_interfaces).toBeInstanceOf(Array);
    expect(profile.output_interfaces.length).toBeGreaterThan(0);
    expect(profile.capabilities).toBeInstanceOf(Array);
    expect(profile.capabilities).toContain("chatbot");
    expect(profile.dependencies).toBeInstanceOf(Array);
    expect(profile.adapter).toBeTruthy();
    expect(profile.adapter.url).toBe(chatbotUrl);
    await adapter.disconnect();
  }, 30000);

  test("low confidence < 0.7 is properly reported", async () => {
    const bus = new EventBus();
    const adapter = createMockAdapter(chatbotUrl);
    await adapter.connect(makeConfig(chatbotUrl));

    const lowConfDetector: Detector = {
      name: "low-conf",
      priority: 10,
      async detect() {
        return { system_type: "rag", confidence: 0.4, evidence: {} };
      },
    };
    const conflictDetector: Detector = {
      name: "conflict",
      priority: 20,
      async detect() {
        return { system_type: "chatbot", confidence: 0.35, evidence: {} };
      },
    };

    const introspector = new Introspector([lowConfDetector, conflictDetector], adapter, bus);
    const profile = await introspector.profile(makeConfig(chatbotUrl, { system_type: "auto" }));

    // Conflicting detectors with close scores -> reduced confidence
    expect(profile.detection_confidence).toBeLessThan(0.7);
    await adapter.disconnect();
  }, 30000);
});

// ============================================================
// 8. Events
// ============================================================

describe("Events", () => {
  test("introspector.started event is emitted", async () => {
    const bus = new EventBus();
    const adapter = createMockAdapter(chatbotUrl);
    await adapter.connect(makeConfig(chatbotUrl));

    let started = false;
    bus.on("introspector.started", () => {
      started = true;
    });

    const introspector = new Introspector([], adapter, bus);
    await introspector.profile(makeConfig(chatbotUrl, { system_type: "chatbot" }));

    expect(started).toBe(true);
    await adapter.disconnect();
  });

  test("introspector.completed event is emitted with profile", async () => {
    const bus = new EventBus();
    const adapter = createMockAdapter(chatbotUrl);
    await adapter.connect(makeConfig(chatbotUrl));

    let completedProfile: unknown = null;
    bus.on("introspector.completed", (data) => {
      completedProfile = data.profile;
    });

    const introspector = new Introspector([], adapter, bus);
    const profile = await introspector.profile(makeConfig(chatbotUrl, { system_type: "chatbot" }));

    expect(completedProfile).not.toBeNull();
    expect((completedProfile as { system_type: string }).system_type).toBe("chatbot");
    expect((completedProfile as { id: string }).id).toBe(profile.id);
    await adapter.disconnect();
  });
});

// ============================================================
// 9. Detector priority ordering
// ============================================================

describe("Detector ordering", () => {
  test("detectors run in priority order (ascending)", async () => {
    const bus = new EventBus();
    const adapter = createMockAdapter(chatbotUrl);
    await adapter.connect(makeConfig(chatbotUrl));

    const order: string[] = [];
    const d1: Detector = {
      name: "high-priority",
      priority: 50,
      async detect() {
        order.push("high-priority");
        return { system_type: null, confidence: 0, evidence: {} };
      },
    };
    const d2: Detector = {
      name: "low-priority",
      priority: 5,
      async detect() {
        order.push("low-priority");
        return { system_type: null, confidence: 0, evidence: {} };
      },
    };
    const d3: Detector = {
      name: "mid-priority",
      priority: 25,
      async detect() {
        order.push("mid-priority");
        return { system_type: null, confidence: 0, evidence: {} };
      },
    };

    // Pass in non-sorted order
    const introspector = new Introspector([d1, d2, d3], adapter, bus);
    await introspector.profile(makeConfig(chatbotUrl, { system_type: "auto" }));

    expect(order).toEqual(["low-priority", "mid-priority", "high-priority"]);
    await adapter.disconnect();
  }, 30000);
});
