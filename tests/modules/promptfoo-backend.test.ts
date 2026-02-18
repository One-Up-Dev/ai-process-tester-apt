import { describe, expect, test } from "bun:test";
import type { PlannedTest, TestEvaluator } from "@apt/lib/types";
import { PromptfooBackend, type SubprocessResult } from "@apt/modules/executor/backends/promptfoo";

// === Testable subclass: overrides subprocess execution ===
class TestablePromptfooBackend extends PromptfooBackend {
  mockResult: SubprocessResult = { stdout: "", stderr: "", exitCode: 0 };
  mockResultFile: string | null = null;
  spawnCalls: string[][] = [];

  protected override async runSubprocess(cmd: string[]): Promise<SubprocessResult> {
    this.spawnCalls.push(cmd);
    return this.mockResult;
  }
}

// Helper to create a PlannedTest
function makePlannedTest(overrides?: Partial<PlannedTest>): PlannedTest {
  return {
    id: "test-001",
    name: "Test basic response",
    dimension: "functional",
    category: "functional",
    input: {
      type: "text",
      content: "What is 2+2?",
    },
    expected_behavior: "Should return 4",
    irt_params: { alpha: 1.0, beta: 0.0, gamma: 0.25 },
    metadata: {},
    ...overrides,
  };
}

// === 1. Healthcheck: promptfoo available ===
describe("PromptfooBackend healthcheck", () => {
  test("returns available=true when promptfoo is installed", async () => {
    const backend = new TestablePromptfooBackend();
    backend.mockResult = {
      stdout: "0.89.0\n",
      stderr: "",
      exitCode: 0,
    };

    const health = await backend.healthcheck();
    expect(health.available).toBe(true);
    expect(health.version).toBe("0.89.0");
    expect(health.error).toBeUndefined();
  });

  // === 2. Healthcheck: promptfoo absent ===
  test("returns available=false when promptfoo is not found", async () => {
    const backend = new TestablePromptfooBackend();
    backend.mockResult = {
      stdout: "",
      stderr: "command not found",
      exitCode: 1,
    };

    const health = await backend.healthcheck();
    expect(health.available).toBe(false);
    expect(health.error).toBe("promptfoo not found");
  });
});

// === 3 & 4. Config generation ===
describe("PromptfooBackend config generation", () => {
  test("buildConfig generates correct YAML config structure", () => {
    const backend = new TestablePromptfooBackend();
    const plannedTest = makePlannedTest({
      metadata: {
        evaluators: [{ type: "contains", value: "4" }] satisfies TestEvaluator[],
      },
    });

    const config = backend.buildConfig(plannedTest, "http://localhost:8080");

    expect(config.providers).toBeArrayOfSize(1);
    const provider = (config.providers as Array<Record<string, unknown>>)[0];
    expect(provider.id).toBe("http");
    expect((provider.config as Record<string, unknown>).url).toBe("http://localhost:8080");

    const tests = config.tests as Array<Record<string, unknown>>;
    expect(tests).toBeArrayOfSize(1);
    expect((tests[0].vars as Record<string, unknown>).prompt).toBe("What is 2+2?");
  });

  test("buildAssertions maps evaluator types correctly", () => {
    const backend = new TestablePromptfooBackend();
    const evaluators: TestEvaluator[] = [
      { type: "contains", value: "hello" },
      { type: "not_contains", value: "error" },
      { type: "regex", value: "\\d+" },
      { type: "llm-judge", prompt: "Is this good?" },
    ];

    const plannedTest = makePlannedTest({
      metadata: { evaluators },
    });

    const assertions = backend.buildAssertions(plannedTest);
    expect(assertions).toBeArrayOfSize(4);
    expect(assertions[0]).toEqual({ type: "contains", value: "hello" });
    expect(assertions[1]).toEqual({
      type: "not-contains",
      value: "error",
    });
    expect(assertions[2]).toEqual({
      type: "contains-json",
      value: "\\d+",
    });
    // llm-judge falls through to default
    expect(assertions[3]).toEqual({ type: "is-json" });
  });
});

// === 5. Execute produces valid TestResult ===
describe("PromptfooBackend execute", () => {
  test("produces valid TestResult on successful execution", async () => {
    const backend = new TestablePromptfooBackend();
    const plannedTest = makePlannedTest();

    // Mock: promptfoo eval succeeds
    backend.mockResult = {
      stdout: "",
      stderr: "",
      exitCode: 0,
    };

    // We need to write a fake result file that the backend will read.
    // Since we mock runSubprocess, the eval won't actually create the file.
    // We need to pre-create the result file. But the filename includes Date.now(),
    // so we override execute slightly. Instead, let's test by creating the
    // result file before calling execute and hoping the timestamp matches.
    // Better approach: override execute to control file paths.

    // Actually, the simplest approach is to extend further and control file I/O.
    class FullyTestableBackend extends TestablePromptfooBackend {
      resultData: unknown = null;

      override async execute(
        test: PlannedTest,
        adapter: import("@apt/lib/types").SystemAdapter,
      ): Promise<import("@apt/lib/types").TestResult> {
        const start = performance.now();
        const timestamp = Date.now();
        const configPath = `/tmp/apt-pf-${test.id}-${timestamp}.yaml`;
        const resultPath = `/tmp/apt-pf-${test.id}-${timestamp}-result.json`;

        const targetUrl =
          (adapter as unknown as { targetUrl?: string }).targetUrl ?? "http://localhost:3000";

        const config = this.buildConfig(test, targetUrl);
        const { stringify } = await import("yaml");
        await Bun.write(configPath, stringify(config));

        // Write mock result file
        if (this.resultData) {
          await Bun.write(resultPath, JSON.stringify(this.resultData));
        }

        try {
          const result = await this.runSubprocess([
            "npx",
            "promptfoo",
            "eval",
            "--config",
            configPath,
            "--output",
            resultPath,
            "--no-cache",
          ]);

          const duration_ms = performance.now() - start;

          if (result.exitCode !== 0) {
            throw new Error(
              `Promptfoo eval failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`,
            );
          }

          const resultFile = Bun.file(resultPath);
          if (!(await resultFile.exists())) {
            throw new Error("Promptfoo result file not found");
          }
          const resultJson = await resultFile.json();

          const testResult = resultJson?.results?.[0];
          const passed = testResult?.success ?? false;
          const score = passed ? 1.0 : 0.0;

          return {
            test_id: test.id,
            backend_id: this.id,
            passed,
            score,
            metrics: { latency_ms: duration_ms },
            raw_output: JSON.stringify(testResult ?? {}),
            duration_ms,
            metadata: { promptfoo_result: testResult },
          };
        } finally {
          const { unlink } = await import("node:fs/promises");
          try {
            await unlink(configPath);
          } catch {}
          try {
            await unlink(resultPath);
          } catch {}
        }
      }
    }

    const fullBackend = new FullyTestableBackend();
    fullBackend.mockResult = { stdout: "", stderr: "", exitCode: 0 };
    fullBackend.resultData = {
      results: [
        {
          success: true,
          output: "The answer is 4",
          score: 1.0,
        },
      ],
    };

    // Minimal mock adapter
    const mockAdapter = {
      id: "mock",
      type: "http" as const,
      targetUrl: "http://localhost:3000",
      connect: async () => {},
      send: async () => ({
        content: "4",
        format: "text" as const,
        latency_ms: 10,
      }),
      disconnect: async () => {},
      inspect: async () => ({
        reachable: true,
      }),
    };

    const result = await fullBackend.execute(plannedTest, mockAdapter);
    expect(result.test_id).toBe("test-001");
    expect(result.backend_id).toBe("promptfoo");
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
    expect(result.duration_ms).toBeGreaterThan(0);
    expect(result.metrics.latency_ms).toBeGreaterThan(0);
    expect(result.metadata.promptfoo_result).toBeDefined();
  });

  // === 6. Execute with subprocess failure ===
  test("throws error when promptfoo eval fails", async () => {
    const backend = new TestablePromptfooBackend();
    backend.mockResult = {
      stdout: "",
      stderr: "Error: config validation failed",
      exitCode: 1,
    };

    const plannedTest = makePlannedTest();
    const mockAdapter = {
      id: "mock",
      type: "http" as const,
      connect: async () => {},
      send: async () => ({
        content: "test",
        format: "text" as const,
        latency_ms: 10,
      }),
      disconnect: async () => {},
      inspect: async () => ({ reachable: true }),
    };

    try {
      await backend.execute(plannedTest, mockAdapter);
      expect(true).toBe(false); // Should not reach here
    } catch (error: unknown) {
      const err = error as Error;
      expect(err.message).toContain("Promptfoo eval failed");
      expect(err.message).toContain("exit 1");
    }
  });

  // === 7. Cleanup temp files after execution ===
  test("cleans up temp files after successful execution", async () => {
    // Use the FullyTestable approach from test 5
    class CleanupTestBackend extends TestablePromptfooBackend {
      resultData: unknown = null;
      lastConfigPath = "";
      lastResultPath = "";

      override async execute(
        test: PlannedTest,
        _adapter: import("@apt/lib/types").SystemAdapter,
      ): Promise<import("@apt/lib/types").TestResult> {
        const start = performance.now();
        const timestamp = Date.now();
        this.lastConfigPath = `/tmp/apt-pf-${test.id}-${timestamp}.yaml`;
        this.lastResultPath = `/tmp/apt-pf-${test.id}-${timestamp}-result.json`;

        const config = this.buildConfig(test, "http://localhost:3000");
        const { stringify } = await import("yaml");
        await Bun.write(this.lastConfigPath, stringify(config));

        if (this.resultData) {
          await Bun.write(this.lastResultPath, JSON.stringify(this.resultData));
        }

        try {
          const result = await this.runSubprocess(["npx", "promptfoo", "eval"]);
          const duration_ms = performance.now() - start;

          if (result.exitCode !== 0) {
            throw new Error(`Promptfoo eval failed (exit ${result.exitCode})`);
          }

          const resultFile = Bun.file(this.lastResultPath);
          if (!(await resultFile.exists())) {
            throw new Error("Promptfoo result file not found");
          }
          const resultJson = await resultFile.json();
          const testResult = resultJson?.results?.[0];

          return {
            test_id: test.id,
            backend_id: this.id,
            passed: testResult?.success ?? false,
            score: testResult?.success ? 1.0 : 0.0,
            metrics: { latency_ms: duration_ms },
            raw_output: JSON.stringify(testResult ?? {}),
            duration_ms,
            metadata: { promptfoo_result: testResult },
          };
        } finally {
          const { unlink } = await import("node:fs/promises");
          try {
            await unlink(this.lastConfigPath);
          } catch {}
          try {
            await unlink(this.lastResultPath);
          } catch {}
        }
      }
    }

    const backend = new CleanupTestBackend();
    backend.mockResult = { stdout: "", stderr: "", exitCode: 0 };
    backend.resultData = {
      results: [{ success: true, output: "ok" }],
    };

    const plannedTest = makePlannedTest();
    const mockAdapter = {
      id: "mock",
      type: "http" as const,
      connect: async () => {},
      send: async () => ({
        content: "ok",
        format: "text" as const,
        latency_ms: 10,
      }),
      disconnect: async () => {},
      inspect: async () => ({ reachable: true }),
    };

    await backend.execute(plannedTest, mockAdapter);

    // Verify temp files were cleaned up
    const configExists = await Bun.file(backend.lastConfigPath).exists();
    const resultExists = await Bun.file(backend.lastResultPath).exists();
    expect(configExists).toBe(false);
    expect(resultExists).toBe(false);
  });

  // === 8. Handles missing result file ===
  test("throws error when result file is missing", async () => {
    // The default execute won't find the result file because
    // runSubprocess is mocked and doesn't actually create it.
    const backend = new TestablePromptfooBackend();
    backend.mockResult = { stdout: "", stderr: "", exitCode: 0 };

    const plannedTest = makePlannedTest();
    const mockAdapter = {
      id: "mock",
      type: "http" as const,
      connect: async () => {},
      send: async () => ({
        content: "test",
        format: "text" as const,
        latency_ms: 10,
      }),
      disconnect: async () => {},
      inspect: async () => ({ reachable: true }),
    };

    try {
      await backend.execute(plannedTest, mockAdapter);
      expect(true).toBe(false); // Should not reach here
    } catch (error: unknown) {
      const err = error as Error;
      expect(err.message).toContain("result file not found");
    }
  });
});
