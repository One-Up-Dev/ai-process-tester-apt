import { unlink } from "node:fs/promises";
import type {
  ExecutionBackend,
  PlannedTest,
  SystemAdapter,
  TestCategory,
  TestEvaluator,
  TestResult,
} from "@apt/lib/types";
import { stringify } from "yaml";

export interface SubprocessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class PromptfooBackend implements ExecutionBackend {
  id = "promptfoo";
  name = "Promptfoo";
  supported_categories: TestCategory[] = ["functional", "robustness", "compliance"];
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
      const result = await this.runSubprocess(["npx", "promptfoo", "--version"]);
      if (result.exitCode === 0) {
        return { available: true, version: result.stdout.trim() };
      }
      return { available: false, error: "promptfoo not found" };
    } catch {
      return { available: false, error: "promptfoo not found" };
    }
  }

  async execute(test: PlannedTest, adapter: SystemAdapter): Promise<TestResult> {
    const start = performance.now();

    // 1. Generate temp YAML config for promptfoo
    const timestamp = Date.now();
    const configPath = `/tmp/apt-pf-${test.id}-${timestamp}.yaml`;
    const resultPath = `/tmp/apt-pf-${test.id}-${timestamp}-result.json`;

    // Get target URL from adapter (assuming HttpAdapter)
    const targetUrl =
      (adapter as unknown as { targetUrl?: string }).targetUrl ?? "http://localhost:3000";

    const config = this.buildConfig(test, targetUrl);
    await Bun.write(configPath, stringify(config));

    try {
      // 2. Run promptfoo eval
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

      // 3. Parse result JSON
      const resultFile = Bun.file(resultPath);
      if (!(await resultFile.exists())) {
        throw new Error("Promptfoo result file not found");
      }
      const resultData = await resultFile.json();

      // Extract results
      const testResult = resultData?.results?.[0];
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
      // 4. Cleanup temp files
      try {
        await unlink(configPath);
      } catch {}
      try {
        await unlink(resultPath);
      } catch {}
    }
  }

  /** Build the promptfoo YAML config object */
  buildConfig(test: PlannedTest, targetUrl: string): Record<string, unknown> {
    return {
      providers: [
        {
          id: "http",
          config: {
            url: targetUrl,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: { input: "{{prompt}}" },
          },
        },
      ],
      tests: [
        {
          vars: { prompt: test.input.content },
          assert: this.buildAssertions(test),
        },
      ],
    };
  }

  /** Convert APT evaluators to promptfoo assertions */
  buildAssertions(test: PlannedTest): Array<{ type: string; value?: string }> {
    const evaluators = (test.metadata?.evaluators as TestEvaluator[]) ?? [];
    return evaluators.map((ev) => {
      switch (ev.type) {
        case "contains":
          return { type: "contains", value: ev.value ?? "" };
        case "not_contains":
          return { type: "not-contains", value: ev.value ?? "" };
        case "regex":
          return { type: "contains-json", value: ev.value ?? "" };
        default:
          return { type: "is-json" };
      }
    });
  }

  /** Overridable subprocess execution for testability */
  protected async runSubprocess(cmd: string[]): Promise<SubprocessResult> {
    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }
}
