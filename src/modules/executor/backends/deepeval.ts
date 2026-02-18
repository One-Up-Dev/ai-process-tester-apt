import { unlink } from "node:fs/promises";
import type {
  ExecutionBackend,
  PlannedTest,
  SystemAdapter,
  TestCategory,
  TestResult,
} from "@apt/lib/types";

export interface SubprocessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class DeepEvalBackend implements ExecutionBackend {
  id = "deepeval";
  name = "DeepEval";
  supported_categories: TestCategory[] = ["functional", "fairness"];
  capabilities = {
    supports_replications: false,
    supports_streaming: false,
    supports_multimodal: false,
    supports_multi_turn: false,
  };

  async healthcheck(): Promise<{
    available: boolean;
    version?: string;
    error?: string;
  }> {
    try {
      const result = await this.runSubprocess([
        "python3",
        "-c",
        "import deepeval; print(deepeval.__version__)",
      ]);
      if (result.exitCode === 0) {
        return { available: true, version: result.stdout.trim() };
      }
      return { available: false, error: "deepeval not installed" };
    } catch {
      return {
        available: false,
        error: "python3 not found or deepeval not installed",
      };
    }
  }

  async execute(test: PlannedTest, adapter: SystemAdapter): Promise<TestResult> {
    const start = performance.now();

    // 1. Send input via adapter to get actual output
    const output = await adapter.send(test.input);

    // 2. Generate temporary Python script
    const scriptPath = `/tmp/apt-de-${test.id}-${Date.now()}.py`;
    const pythonScript = this.generateScript(test, output.content);
    await Bun.write(scriptPath, pythonScript);

    try {
      // 3. Execute Python script
      const result = await this.runSubprocess(["python3", scriptPath]);
      const duration_ms = performance.now() - start;

      if (result.exitCode !== 0) {
        throw new Error(
          `DeepEval script failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`,
        );
      }

      // 4. Parse stdout JSON
      let parsed: { passed: boolean; score: number; reason?: string };
      try {
        parsed = JSON.parse(result.stdout.trim());
      } catch {
        throw new Error(`Invalid JSON from DeepEval script: ${result.stdout.slice(0, 200)}`);
      }

      return {
        test_id: test.id,
        backend_id: this.id,
        passed: parsed.passed,
        score: parsed.score,
        metrics: { latency_ms: output.latency_ms },
        raw_output: output.content,
        duration_ms,
        metadata: { deepeval_result: parsed },
      };
    } finally {
      // Cleanup
      try {
        await unlink(scriptPath);
      } catch {}
    }
  }

  /** Generate the DeepEval Python evaluation script */
  generateScript(test: PlannedTest, actualOutput: string): string {
    const safeInput = JSON.stringify(test.input.content);
    const safeOutput = JSON.stringify(actualOutput);
    const safeExpected = JSON.stringify(test.expected_behavior);
    const safeContext = JSON.stringify(test.input.context?.system_prompt ?? "");

    return `
import json
try:
    from deepeval.metrics import AnswerRelevancyMetric
    from deepeval.test_case import LLMTestCase

    test_case = LLMTestCase(
        input=${safeInput},
        actual_output=${safeOutput},
        expected_output=${safeExpected},
        context=[${safeContext}] if ${safeContext} else None,
    )

    metric = AnswerRelevancyMetric(threshold=0.5)
    metric.measure(test_case)

    print(json.dumps({
        "passed": metric.is_successful(),
        "score": metric.score,
        "reason": metric.reason if hasattr(metric, 'reason') else None,
    }))
except Exception as e:
    print(json.dumps({
        "passed": False,
        "score": 0.0,
        "reason": str(e),
    }))
`;
  }

  /** Overridable subprocess execution for testability */
  protected async runSubprocess(cmd: string[]): Promise<SubprocessResult> {
    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }
}
