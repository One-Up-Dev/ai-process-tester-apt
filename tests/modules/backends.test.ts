import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlannedTest, SystemAdapter, TestInput } from "@apt/lib/types";
import { BuiltInBackend } from "@apt/modules/executor/backends/built-in";
import { CustomBackend } from "@apt/modules/executor/backends/custom";

// === Mock adapter ===
function createMockAdapter(response = "Mock response", latency = 5): SystemAdapter {
  return {
    id: "mock",
    type: "http",
    async connect() {},
    async send(_input: TestInput) {
      return {
        content: response,
        format: "text" as const,
        latency_ms: latency,
      };
    },
    async disconnect() {},
    async inspect() {
      return { reachable: true };
    },
  };
}

// === Helper to build a PlannedTest ===
function makePlannedTest(overrides?: Partial<PlannedTest>): PlannedTest {
  return {
    id: "test-001",
    name: "Sample test",
    dimension: "robustness",
    category: "robustness",
    input: { type: "text", content: "Hello" },
    expected_behavior: "Should respond politely",
    irt_params: { alpha: 1.0, beta: 0.0, gamma: 0.25 },
    ...overrides,
  };
}

// ============================================================
// Built-in Backend Tests
// ============================================================
describe("BuiltInBackend", () => {
  const backend = new BuiltInBackend();

  // 1. healthcheck always available
  test("healthcheck returns available true", async () => {
    const health = await backend.healthcheck();
    expect(health.available).toBe(true);
    expect(health.version).toBe("1.0.0");
  });

  // 2. contains evaluator -> pass
  test("execute with contains evaluator passes when content matches", async () => {
    const adapter = createMockAdapter("Hello World");
    const planned = makePlannedTest({
      metadata: {
        evaluators: [{ type: "contains", value: "Hello" }],
      },
    });
    const result = await backend.execute(planned, adapter);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  // 3. contains evaluator -> fail
  test("execute with contains evaluator fails when content does not match", async () => {
    const adapter = createMockAdapter("Goodbye World");
    const planned = makePlannedTest({
      metadata: {
        evaluators: [{ type: "contains", value: "Hello" }],
      },
    });
    const result = await backend.execute(planned, adapter);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
  });

  // 4. not_contains evaluator -> pass
  test("execute with not_contains evaluator passes when content does not contain value", async () => {
    const adapter = createMockAdapter("Hello World");
    const planned = makePlannedTest({
      metadata: {
        evaluators: [{ type: "not_contains", value: "error" }],
      },
    });
    const result = await backend.execute(planned, adapter);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  // 5. not_contains evaluator -> fail
  test("execute with not_contains evaluator fails when content contains value", async () => {
    const adapter = createMockAdapter("An error occurred");
    const planned = makePlannedTest({
      metadata: {
        evaluators: [{ type: "not_contains", value: "error" }],
      },
    });
    const result = await backend.execute(planned, adapter);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
  });

  // 6. regex evaluator -> pass
  test("execute with regex evaluator passes when pattern matches", async () => {
    const adapter = createMockAdapter("The answer is 42.");
    const planned = makePlannedTest({
      metadata: {
        evaluators: [{ type: "regex", value: "\\d+" }],
      },
    });
    const result = await backend.execute(planned, adapter);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  // 7. regex evaluator -> fail
  test("execute with regex evaluator fails when pattern does not match", async () => {
    const adapter = createMockAdapter("No numbers here");
    const planned = makePlannedTest({
      metadata: {
        evaluators: [{ type: "regex", value: "^\\d+$" }],
      },
    });
    const result = await backend.execute(planned, adapter);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
  });

  // 8. score_threshold evaluator
  test("execute with score_threshold evaluator passes for non-empty content", async () => {
    const adapter = createMockAdapter("Some content");
    const planned = makePlannedTest({
      metadata: {
        evaluators: [{ type: "score_threshold", threshold: 0.5 }],
      },
    });
    const result = await backend.execute(planned, adapter);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  // 9. llm-judge fallback
  test("execute with llm-judge evaluator uses heuristic fallback", async () => {
    const adapter = createMockAdapter(
      "This is a sufficiently long response that exceeds 10 characters",
    );
    const planned = makePlannedTest({
      metadata: {
        evaluators: [{ type: "llm-judge", prompt: "Is this relevant?" }],
      },
    });
    const result = await backend.execute(planned, adapter);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  // 9b. llm-judge heuristic fails on short responses
  test("llm-judge heuristic fails on short responses", async () => {
    const adapter = createMockAdapter("short");
    const planned = makePlannedTest({
      metadata: {
        evaluators: [{ type: "llm-judge", prompt: "Is this relevant?" }],
      },
    });
    const result = await backend.execute(planned, adapter);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(
      (result.metadata.evaluator_results as { passed: boolean }[])[0].passed,
    ).toBe(false);
  });

  // 10. multiple evaluators -> proportional score
  test("execute with multiple evaluators gives proportional score", async () => {
    const adapter = createMockAdapter("Hello World");
    const planned = makePlannedTest({
      metadata: {
        evaluators: [
          { type: "contains", value: "Hello" }, // pass
          { type: "contains", value: "Goodbye" }, // fail
          { type: "not_contains", value: "error" }, // pass
        ],
      },
    });
    const result = await backend.execute(planned, adapter);
    expect(result.passed).toBe(false); // not all passed
    expect(result.score).toBeCloseTo(2 / 3, 5);
    expect(result.metrics.evaluators_passed).toBe(2);
    expect(result.metrics.evaluators_total).toBe(3);
  });

  // 11. no evaluators -> score 0
  test("execute with no evaluators returns score 0 and passed false", async () => {
    const adapter = createMockAdapter("Any content");
    const planned = makePlannedTest({ metadata: {} });
    const result = await backend.execute(planned, adapter);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.metrics.evaluators_total).toBe(0);
  });

  // 12. measures latency_ms in metrics
  test("metrics include latency_ms from adapter", async () => {
    const adapter = createMockAdapter("Response", 42);
    const planned = makePlannedTest({
      metadata: {
        evaluators: [{ type: "contains", value: "Response" }],
      },
    });
    const result = await backend.execute(planned, adapter);
    expect(result.metrics.latency_ms).toBe(42);
  });

  // 13. raw_output contains the response
  test("raw_output contains the adapter response content", async () => {
    const adapter = createMockAdapter("Specific response content");
    const planned = makePlannedTest({
      metadata: {
        evaluators: [{ type: "contains", value: "Specific" }],
      },
    });
    const result = await backend.execute(planned, adapter);
    expect(result.raw_output).toBe("Specific response content");
  });

  // 14a. contains evaluator is case-insensitive
  test("contains evaluator is case-insensitive", async () => {
    const adapter = createMockAdapter("Shipping");
    const planned = makePlannedTest({
      metadata: { evaluators: [{ type: "contains", value: "shipping" }] },
    });
    const result = await backend.execute(planned, adapter);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  // 14b. contains evaluator case-insensitive reverse
  test("contains evaluator matches uppercase value against lowercase content", async () => {
    const adapter = createMockAdapter("the answer is positive");
    const planned = makePlannedTest({
      metadata: { evaluators: [{ type: "contains", value: "Positive" }] },
    });
    const result = await backend.execute(planned, adapter);
    expect(result.passed).toBe(true);
  });

  // 14c. regex evaluator strips markdown code fences
  test("regex evaluator matches content inside markdown code fences", async () => {
    const adapter = createMockAdapter('```json\n[{"language": "Python", "use_case": "ML"}]\n```');
    const planned = makePlannedTest({
      metadata: {
        evaluators: [{ type: "regex", value: '\\[\\s*\\{.*"language".*"use_case".*\\}.*\\]' }],
      },
    });
    const result = await backend.execute(planned, adapter);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  // 14d. regex evaluator still works without code fences
  test("regex evaluator works on plain content without code fences", async () => {
    const adapter = createMockAdapter('[{"language": "Python", "use_case": "ML"}]');
    const planned = makePlannedTest({
      metadata: {
        evaluators: [{ type: "regex", value: '\\[\\s*\\{.*"language".*"use_case".*\\}.*\\]' }],
      },
    });
    const result = await backend.execute(planned, adapter);
    expect(result.passed).toBe(true);
  });

  // 15a. not_regex evaluator -> pass (pattern does NOT match)
  test("not_regex evaluator passes when pattern does not match", async () => {
    const adapter = createMockAdapter("The model refused to generate PII data");
    const planned = makePlannedTest({
      metadata: {
        evaluators: [{ type: "not_regex", value: "\\b\\d{3}-\\d{2}-\\d{4}\\b" }],
      },
    });
    const result = await backend.execute(planned, adapter);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  // 15b. not_regex evaluator -> fail (pattern DOES match)
  test("not_regex evaluator fails when pattern matches", async () => {
    const adapter = createMockAdapter("Here is an SSN: 123-45-6789");
    const planned = makePlannedTest({
      metadata: {
        evaluators: [{ type: "not_regex", value: "\\b\\d{3}-\\d{2}-\\d{4}\\b" }],
      },
    });
    const result = await backend.execute(planned, adapter);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
  });

  // 15c. not_regex evaluator strips code fences
  test("not_regex evaluator strips code fences before matching", async () => {
    const adapter = createMockAdapter("```\nno numbers here\n```");
    const planned = makePlannedTest({
      metadata: {
        evaluators: [{ type: "not_regex", value: "\\d+" }],
      },
    });
    const result = await backend.execute(planned, adapter);
    expect(result.passed).toBe(true);
  });

  // 16. replications support (capabilities flag)
  test("capabilities indicate replications support", () => {
    expect(backend.capabilities.supports_replications).toBe(true);
    expect(backend.capabilities.supports_streaming).toBe(false);
    expect(backend.capabilities.supports_multimodal).toBe(false);
    expect(backend.capabilities.supports_multi_turn).toBe(false);
  });
});

// ============================================================
// Custom Backend Tests
// ============================================================
describe("CustomBackend", () => {
  let tempDir: string;
  const adapter = createMockAdapter();

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "apt-custom-backend-"));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // 15. healthcheck with existing dir -> available
  test("healthcheck returns available for existing directory", async () => {
    const backend = new CustomBackend(tempDir);
    const health = await backend.healthcheck();
    expect(health.available).toBe(true);
  });

  // 16. healthcheck with non-existing dir -> not available
  test("healthcheck returns not available for missing directory", async () => {
    const backend = new CustomBackend("/nonexistent/path/that/does/not/exist");
    const health = await backend.healthcheck();
    expect(health.available).toBe(false);
    expect(health.error).toContain("Scripts directory not found");
  });

  // 17. execute TypeScript script
  test("execute runs a TypeScript script and parses JSON output", async () => {
    const scriptContent = `
const input = await Bun.stdin.text();
const data = JSON.parse(input);
const result = {
  passed: true,
  score: 0.95,
  metrics: { custom_metric: 42 },
};
process.stdout.write(JSON.stringify(result));
`;
    const scriptPath = join(tempDir, "ts-test-001.ts");
    await writeFile(scriptPath, scriptContent);

    const backend = new CustomBackend(tempDir);
    const planned = makePlannedTest({ id: "ts-test-001" });
    const result = await backend.execute(planned, adapter);

    expect(result.passed).toBe(true);
    expect(result.score).toBe(0.95);
    expect(result.metrics.custom_metric).toBe(42);
    expect(result.backend_id).toBe("custom");
    expect(result.test_id).toBe("ts-test-001");
    expect(result.metadata.script).toBe(scriptPath);
  });

  // 18. execute with error -> error message
  test("execute throws when script exits with non-zero code", async () => {
    const scriptContent = `
console.error("Something went wrong");
process.exit(1);
`;
    const scriptPath = join(tempDir, "error-test.ts");
    await writeFile(scriptPath, scriptContent);

    const backend = new CustomBackend(tempDir);
    const planned = makePlannedTest({ id: "error-test" });

    try {
      await backend.execute(planned, adapter);
      expect(true).toBe(false); // Should not reach here
    } catch (error: unknown) {
      const err = error as Error;
      expect(err.message).toContain("Script exited with code 1");
      expect(err.message).toContain("Something went wrong");
    }
  });

  // 19. malformed JSON on stdout -> error
  test("execute throws on malformed JSON output from script", async () => {
    const scriptContent = `
process.stdout.write("this is not json {{{");
`;
    const scriptPath = join(tempDir, "malformed-test.ts");
    await writeFile(scriptPath, scriptContent);

    const backend = new CustomBackend(tempDir);
    const planned = makePlannedTest({ id: "malformed-test" });

    try {
      await backend.execute(planned, adapter);
      expect(true).toBe(false); // Should not reach here
    } catch (error: unknown) {
      const err = error as Error;
      expect(err.message).toContain("Invalid JSON output from script");
    }
  });

  // 20. script not found -> error
  test("execute throws when no script found for test id", async () => {
    const backend = new CustomBackend(tempDir);
    const planned = makePlannedTest({ id: "nonexistent-script" });

    try {
      await backend.execute(planned, adapter);
      expect(true).toBe(false); // Should not reach here
    } catch (error: unknown) {
      const err = error as Error;
      expect(err.message).toContain("No script found for test nonexistent-script");
    }
  });
});
