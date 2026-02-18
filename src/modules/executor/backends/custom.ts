import type {
  ExecutionBackend,
  PlannedTest,
  SystemAdapter,
  TestCategory,
  TestResult,
} from "@apt/lib/types";

export class CustomBackend implements ExecutionBackend {
  id = "custom";
  name = "Custom Script Backend";
  supported_categories: TestCategory[] = [
    "functional",
    "robustness",
    "security",
    "fairness",
    "performance",
    "compliance",
  ];
  capabilities = {
    supports_replications: true,
    supports_streaming: false,
    supports_multimodal: false,
    supports_multi_turn: false,
  };

  constructor(private scriptsDir: string) {}

  async healthcheck() {
    try {
      const { readdir } = await import("node:fs/promises");
      await readdir(this.scriptsDir);
      return { available: true, version: "1.0.0" };
    } catch {
      return {
        available: false,
        version: "1.0.0",
        error: `Scripts directory not found: ${this.scriptsDir}`,
      };
    }
  }

  async execute(test: PlannedTest, _adapter: SystemAdapter): Promise<TestResult> {
    const start = performance.now();

    // 1. Find script: {scriptsDir}/{test.id}.{ts,js,py,sh}
    const extensions = ["ts", "js", "py", "sh"];
    let scriptPath: string | null = null;
    let ext: string | null = null;

    for (const e of extensions) {
      const path = `${this.scriptsDir}/${test.id}.${e}`;
      if (await Bun.file(path).exists()) {
        scriptPath = path;
        ext = e;
        break;
      }
    }

    if (!scriptPath || !ext) {
      throw new Error(`No script found for test ${test.id} in ${this.scriptsDir}`);
    }

    // 2. Build command based on extension
    const cmd =
      ext === "ts" || ext === "js"
        ? ["bun", "run", scriptPath]
        : ext === "py"
          ? ["python3", scriptPath]
          : ["bash", scriptPath];

    // 3. Execute with test input as JSON on stdin
    const input = JSON.stringify({
      test_id: test.id,
      input: test.input,
      expected_behavior: test.expected_behavior,
    });

    const proc = Bun.spawn(cmd, {
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const duration_ms = performance.now() - start;

    if (exitCode !== 0) {
      throw new Error(`Script exited with code ${exitCode}: ${stderr}`);
    }

    // 4. Parse JSON result from stdout
    let result: {
      passed: boolean;
      score: number;
      metrics?: Record<string, number>;
    };
    try {
      result = JSON.parse(stdout);
    } catch {
      throw new Error(`Invalid JSON output from script: ${stdout.slice(0, 200)}`);
    }

    return {
      test_id: test.id,
      backend_id: this.id,
      passed: result.passed,
      score: result.score,
      metrics: result.metrics ?? {},
      raw_output: stdout,
      duration_ms,
      metadata: { script: scriptPath },
    };
  }
}
