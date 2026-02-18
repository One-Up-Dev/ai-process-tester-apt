import type { EventBus } from "@apt/core/event-bus";
import type {
  ExecutionBackend,
  PlannedTest,
  SystemAdapter,
  TestInput,
  TestResult,
} from "@apt/lib/types";

export interface NoiseConfig {
  warmup_count: number; // default 3
  replications: number; // default 3
  cv_threshold: number; // default 0.15
}

export class NoiseIsolator {
  constructor(private config: NoiseConfig) {}

  async warmup(adapter: SystemAdapter, input: TestInput, bus?: EventBus): Promise<void> {
    for (let i = 0; i < this.config.warmup_count; i++) {
      bus?.emit("executor.warmup.progress", {
        current: i + 1,
        total: this.config.warmup_count,
      });
      await adapter.send(input);
    }
  }

  async executeWithReplications(
    backend: ExecutionBackend,
    test: PlannedTest,
    adapter: SystemAdapter,
    replications: number,
  ): Promise<{ result: TestResult; noise_cv: number; noise_flag: boolean }> {
    if (replications <= 1) {
      const result = await backend.execute(test, adapter);
      return { result, noise_cv: 0, noise_flag: false };
    }

    // Execute N times
    const results: TestResult[] = [];
    for (let i = 0; i < replications; i++) {
      results.push(await backend.execute(test, adapter));
    }

    // Calculate CV on scores
    const scores = results.map((r) => r.score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
    const stddev = Math.sqrt(variance);
    const cv = mean > 0 ? stddev / mean : 0;

    // Pick median result
    const sorted = [...results].sort((a, b) => a.score - b.score);
    const medianResult = sorted[Math.floor(sorted.length / 2)];

    // Add replications data
    medianResult.replications = results.map((r) => ({
      passed: r.passed,
      score: r.score,
      duration_ms: r.duration_ms,
    }));

    return {
      result: medianResult,
      noise_cv: cv,
      noise_flag: cv > this.config.cv_threshold,
    };
  }
}
