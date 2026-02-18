import type { EventBus } from "@apt/core/event-bus";
import type {
  ExecutionBackend,
  ExecutionConfig,
  ExecutionResults,
  IRTEstimate,
  IRTItem,
  PlannedTest,
  SystemAdapter,
  SystemProfile,
  TestDimension,
  TestPlan,
  TestResult,
} from "@apt/lib/types";
import { CATEngine } from "./irt/index";
import { NoiseIsolator } from "./noise";

export class AdaptiveExecutor {
  private noiseIsolator: NoiseIsolator;

  constructor(
    private backends: ExecutionBackend[],
    private bus: EventBus,
    private config: ExecutionConfig,
  ) {
    this.noiseIsolator = new NoiseIsolator({
      warmup_count: config.warmup_count,
      replications: config.replications,
      cv_threshold: 0.15,
    });
  }

  async execute(
    plan: TestPlan,
    adapter: SystemAdapter,
    evaluationId: string,
  ): Promise<ExecutionResults> {
    this.bus.emit("executor.started", { plan });

    // 1. Healthcheck backends
    const available = await this.healthcheckBackends();

    // 2. Warmup
    if (plan.tests.length > 0) {
      await this.noiseIsolator.warmup(adapter, plan.tests[0].input, this.bus);
    }

    // 3. Execute based on strategy
    let results: ExecutionResults;
    if (plan.strategy === "adaptive") {
      results = await this.executeAdaptive(plan.tests, adapter, available, evaluationId);
    } else {
      results = await this.executeExhaustive(plan.tests, adapter, available, evaluationId);
    }

    this.bus.emit("executor.completed", { results });
    return results;
  }

  private async healthcheckBackends(): Promise<ExecutionBackend[]> {
    const available: ExecutionBackend[] = [];
    for (const backend of this.backends) {
      const health = await backend.healthcheck();
      if (health.available) available.push(backend);
    }
    return available;
  }

  private async executeAdaptive(
    tests: PlannedTest[],
    adapter: SystemAdapter,
    backends: ExecutionBackend[],
    evaluationId: string,
  ): Promise<ExecutionResults> {
    const results: TestResult[] = [];
    const irtEstimates: IRTEstimate[] = [];

    // Group tests by dimension
    const byDimension = this.groupByDimension(tests);

    for (const [dimension, dimTests] of byDimension) {
      // Convert PlannedTest[] -> IRTItem[]
      const irtItems: IRTItem[] = dimTests.map((t) => ({
        id: t.id,
        alpha: t.irt_params.alpha,
        beta: t.irt_params.beta,
        gamma: t.irt_params.gamma,
        dimension,
        is_preliminary: (t.metadata?.is_preliminary as boolean) ?? true,
      }));

      const engine = new CATEngine(irtItems, dimension, {
        seThreshold: this.config.se_threshold,
        maxTests: this.config.max_tests,
      });

      // CAT loop
      while (true) {
        const convergence = engine.isConverged();
        if (convergence.converged) {
          this.bus.emit("executor.dimension.converged", {
            dimension,
            theta: engine.getState().theta,
            se: engine.getState().se,
            reason: convergence.reason ?? "unknown",
          });
          break;
        }

        const nextItem = engine.nextItem();
        if (!nextItem) break;

        const test = dimTests.find((t) => t.id === nextItem.id);
        if (!test) break;
        this.bus.emit("executor.test.started", {
          test_id: test.id,
          dimension,
        });

        const backend = this.selectBackend(test, backends);
        try {
          const { result, noise_cv, noise_flag } = await this.noiseIsolator.executeWithReplications(
            backend,
            test,
            adapter,
            this.config.replications,
          );

          // Store noise data in result metadata
          result.metadata = { ...result.metadata, noise_cv, noise_flag };

          const response: 0 | 1 = result.passed ? 1 : 0;
          const irtResult = engine.recordResponse(nextItem.id, response);

          this.bus.emit("executor.test.completed", {
            test_id: test.id,
            passed: result.passed,
            theta: irtResult.theta,
            se: irtResult.se,
            dimension,
          });
          this.bus.emit("executor.irt.updated", {
            dimension,
            theta: irtResult.theta,
            se: irtResult.se,
            n_tests: engine.getState().responses.length,
          });

          results.push(result);
        } catch (err) {
          // Test failed (timeout, network error, etc.) — record as failure and continue
          const irtResult = engine.recordResponse(nextItem.id, 0);

          this.bus.emit("executor.test.completed", {
            test_id: test.id,
            passed: false,
            theta: irtResult.theta,
            se: irtResult.se,
            dimension,
          });
          this.bus.emit("executor.irt.updated", {
            dimension,
            theta: irtResult.theta,
            se: irtResult.se,
            n_tests: engine.getState().responses.length,
          });

          results.push({
            test_id: test.id,
            backend_id: backend.id,
            passed: false,
            score: 0,
            metrics: {},
            raw_output: `Error: ${err instanceof Error ? err.message : String(err)}`,
            duration_ms: 0,
            metadata: { error: true },
          });
        }
      }

      const catResults = engine.getResults();
      irtEstimates.push({
        dimension,
        theta: catResults.theta,
        se: catResults.se,
        ci_lower: catResults.ciLower,
        ci_upper: catResults.ciUpper,
        n_tests: catResults.nTests,
        normalized_score: catResults.normalizedScore,
      });
    }

    return {
      evaluation_id: evaluationId,
      system_profile: {} as SystemProfile, // filled by pipeline
      test_results: results,
      irt_estimates: irtEstimates,
      execution_metadata: {
        strategy: "adaptive",
        backends_used: backends.map((b) => b.id),
      },
    };
  }

  private async executeExhaustive(
    tests: PlannedTest[],
    adapter: SystemAdapter,
    backends: ExecutionBackend[],
    evaluationId: string,
  ): Promise<ExecutionResults> {
    const results: TestResult[] = [];

    for (const test of tests) {
      this.bus.emit("executor.test.started", {
        test_id: test.id,
        dimension: test.dimension,
      });

      const backend = this.selectBackend(test, backends);
      try {
        const { result, noise_cv, noise_flag } = await this.noiseIsolator.executeWithReplications(
          backend,
          test,
          adapter,
          this.config.replications,
        );

        // Store noise data in result metadata
        result.metadata = { ...result.metadata, noise_cv, noise_flag };

        this.bus.emit("executor.test.completed", {
          test_id: test.id,
          passed: result.passed,
          theta: 0,
          se: 0,
          dimension: test.dimension,
        });

        results.push(result);
      } catch (err) {
        // Test failed — record as failure and continue
        this.bus.emit("executor.test.completed", {
          test_id: test.id,
          passed: false,
          theta: 0,
          se: 0,
          dimension: test.dimension,
        });

        results.push({
          test_id: test.id,
          backend_id: backend.id,
          passed: false,
          score: 0,
          metrics: {},
          raw_output: `Error: ${err instanceof Error ? err.message : String(err)}`,
          duration_ms: 0,
          metadata: { error: true },
        });
      }
    }

    // Calculate IRT estimates after execution
    const byDimension = this.groupByDimension(tests);
    const irtEstimates: IRTEstimate[] = [];

    for (const [dimension, dimTests] of byDimension) {
      const irtItems: IRTItem[] = dimTests.map((t) => ({
        id: t.id,
        alpha: t.irt_params.alpha,
        beta: t.irt_params.beta,
        gamma: t.irt_params.gamma,
        dimension,
      }));

      const engine = new CATEngine(irtItems, dimension);
      // Record all responses
      for (const test of dimTests) {
        const result = results.find((r) => r.test_id === test.id);
        if (result) {
          engine.recordResponse(test.id, result.passed ? 1 : 0);
        }
      }

      const catResults = engine.getResults();
      irtEstimates.push({
        dimension,
        theta: catResults.theta,
        se: catResults.se,
        ci_lower: catResults.ciLower,
        ci_upper: catResults.ciUpper,
        n_tests: catResults.nTests,
        normalized_score: catResults.normalizedScore,
      });
    }

    return {
      evaluation_id: evaluationId,
      system_profile: {} as SystemProfile,
      test_results: results,
      irt_estimates: irtEstimates,
      execution_metadata: {
        strategy: "exhaustive",
        backends_used: backends.map((b) => b.id),
      },
    };
  }

  private groupByDimension(tests: PlannedTest[]): Map<TestDimension, PlannedTest[]> {
    const map = new Map<TestDimension, PlannedTest[]>();
    for (const test of tests) {
      const list = map.get(test.dimension) ?? [];
      list.push(test);
      map.set(test.dimension, list);
    }
    return map;
  }

  private selectBackend(test: PlannedTest, available: ExecutionBackend[]): ExecutionBackend {
    // Check test.metadata.backends for preferred backends
    const preferred = (test.metadata?.backends as string[]) ?? [];
    for (const backendId of preferred) {
      const backend = available.find((b) => b.id === backendId);
      if (backend) return backend;
    }
    // Fallback: built-in
    const builtIn = available.find((b) => b.id === "built-in");
    if (builtIn) return builtIn;
    // Last resort: first available
    if (available.length > 0) return available[0];
    throw new Error("No backends available");
  }
}

// Re-export
export { NoiseIsolator, type NoiseConfig } from "./noise";
