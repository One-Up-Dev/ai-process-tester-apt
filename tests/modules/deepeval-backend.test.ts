import { describe, expect, test } from "bun:test";
import type { PlannedTest } from "@apt/lib/types";
import { DeepEvalBackend, type SubprocessResult } from "@apt/modules/executor/backends/deepeval";

// === Testable subclass: overrides subprocess execution ===
class TestableDeepEvalBackend extends DeepEvalBackend {
  mockResult: SubprocessResult = { stdout: "", stderr: "", exitCode: 0 };
  spawnCalls: string[][] = [];

  protected override async runSubprocess(cmd: string[]): Promise<SubprocessResult> {
    this.spawnCalls.push(cmd);
    return this.mockResult;
  }
}

// Helper to create a PlannedTest
function makePlannedTest(overrides?: Partial<PlannedTest>): PlannedTest {
  return {
    id: "test-de-001",
    name: "Test answer relevancy",
    dimension: "functional",
    category: "functional",
    input: {
      type: "text",
      content: "What is machine learning?",
      context: {
        system_prompt: "You are a helpful AI assistant.",
      },
    },
    expected_behavior: "Should explain machine learning clearly",
    irt_params: { alpha: 1.0, beta: 0.0, gamma: 0.25 },
    metadata: {},
    ...overrides,
  };
}

// Mock adapter factory
function makeMockAdapter() {
  return {
    id: "mock",
    type: "http" as const,
    connect: async () => {},
    send: async () => ({
      content: "Machine learning is a subset of AI that enables systems to learn from data.",
      format: "text" as const,
      latency_ms: 42,
    }),
    disconnect: async () => {},
    inspect: async () => ({ reachable: true }),
  };
}

// === 1. Healthcheck: deepeval available ===
describe("DeepEvalBackend healthcheck", () => {
  test("returns available=true when deepeval is installed", async () => {
    const backend = new TestableDeepEvalBackend();
    backend.mockResult = {
      stdout: "1.3.2\n",
      stderr: "",
      exitCode: 0,
    };

    const health = await backend.healthcheck();
    expect(health.available).toBe(true);
    expect(health.version).toBe("1.3.2");
    expect(health.error).toBeUndefined();
  });

  // === 2. Healthcheck: deepeval absent ===
  test("returns available=false when deepeval is not installed", async () => {
    const backend = new TestableDeepEvalBackend();
    backend.mockResult = {
      stdout: "",
      stderr: "ModuleNotFoundError: No module named 'deepeval'",
      exitCode: 1,
    };

    const health = await backend.healthcheck();
    expect(health.available).toBe(false);
    expect(health.error).toBe("deepeval not installed");
  });
});

// === 3 & 4. Python script generation ===
describe("DeepEvalBackend script generation", () => {
  test("generates valid Python script with correct structure", () => {
    const backend = new TestableDeepEvalBackend();
    const plannedTest = makePlannedTest();
    const actualOutput = "ML is a branch of artificial intelligence.";

    const script = backend.generateScript(plannedTest, actualOutput);

    // Should import deepeval
    expect(script).toContain("from deepeval.metrics import AnswerRelevancyMetric");
    expect(script).toContain("from deepeval.test_case import LLMTestCase");
    // Should contain json output
    expect(script).toContain("print(json.dumps(");
    // Should have error handling
    expect(script).toContain("except Exception as e:");
  });

  test("script contains correctly escaped input and output", () => {
    const backend = new TestableDeepEvalBackend();
    const plannedTest = makePlannedTest({
      input: {
        type: "text",
        content: 'What is "machine learning"?',
        context: {
          system_prompt: "You are a helpful assistant.",
        },
      },
      expected_behavior: "Should explain ML with examples",
    });
    const actualOutput = 'ML is a "subset" of AI.';

    const script = backend.generateScript(plannedTest, actualOutput);

    // Input should be JSON-stringified (escaped quotes)
    expect(script).toContain(JSON.stringify('What is "machine learning"?'));
    // Output should be JSON-stringified
    expect(script).toContain(JSON.stringify('ML is a "subset" of AI.'));
    // Expected behavior should be present
    expect(script).toContain(JSON.stringify("Should explain ML with examples"));
    // System prompt should be present
    expect(script).toContain(JSON.stringify("You are a helpful assistant."));
  });
});

// === 5. Execute produces valid TestResult ===
describe("DeepEvalBackend execute", () => {
  test("produces valid TestResult on successful execution", async () => {
    const backend = new TestableDeepEvalBackend();
    backend.mockResult = {
      stdout: JSON.stringify({
        passed: true,
        score: 0.87,
        reason: "Answer is relevant to the question",
      }),
      stderr: "",
      exitCode: 0,
    };

    const plannedTest = makePlannedTest();
    const result = await backend.execute(plannedTest, makeMockAdapter());

    expect(result.test_id).toBe("test-de-001");
    expect(result.backend_id).toBe("deepeval");
    expect(result.passed).toBe(true);
    expect(result.score).toBe(0.87);
    expect(result.metrics.latency_ms).toBe(42);
    expect(result.raw_output).toContain("Machine learning");
    expect(result.duration_ms).toBeGreaterThan(0);
    expect((result.metadata.deepeval_result as { reason: string }).reason).toBe(
      "Answer is relevant to the question",
    );
  });

  // === 6. Execute with Python failure ===
  test("throws error when Python script fails", async () => {
    const backend = new TestableDeepEvalBackend();
    backend.mockResult = {
      stdout: "",
      stderr: "Traceback (most recent call last):\n  SyntaxError: invalid syntax",
      exitCode: 1,
    };

    const plannedTest = makePlannedTest();

    try {
      await backend.execute(plannedTest, makeMockAdapter());
      expect(true).toBe(false); // Should not reach here
    } catch (error: unknown) {
      const err = error as Error;
      expect(err.message).toContain("DeepEval script failed");
      expect(err.message).toContain("exit 1");
    }
  });

  // === 7. Handles invalid JSON output ===
  test("throws error on invalid JSON output from script", async () => {
    const backend = new TestableDeepEvalBackend();
    backend.mockResult = {
      stdout: "not valid json at all {{{",
      stderr: "",
      exitCode: 0,
    };

    const plannedTest = makePlannedTest();

    try {
      await backend.execute(plannedTest, makeMockAdapter());
      expect(true).toBe(false); // Should not reach here
    } catch (error: unknown) {
      const err = error as Error;
      expect(err.message).toContain("Invalid JSON from DeepEval script");
    }
  });
});
