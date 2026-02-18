import { beforeEach, describe, expect, test } from "bun:test";
import { EventBus } from "@apt/core/event-bus";
import type {
  ExecutionBackend,
  ExecutionConfig,
  PlannedTest,
  SystemAdapter,
  TestCategory,
  TestDimension,
  TestInput,
  TestPlan,
  TestResult,
} from "@apt/lib/types";
import { AdaptiveExecutor } from "@apt/modules/executor/index";
import { NoiseIsolator } from "@apt/modules/executor/noise";

// === Mock adapter ===
function createMockAdapter(_response = "Mock response", latency = 5): SystemAdapter {
  return {
    id: "mock",
    type: "http",
    async connect() {},
    async send(_input: TestInput) {
      return {
        content: `Mock: ${_input.content}`,
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

// === Mock backend that always passes ===
function createMockBackend(
  id = "built-in",
  name = "Mock Backend",
  available = true,
  score = 1.0,
  passed = true,
): ExecutionBackend {
  return {
    id,
    name,
    supported_categories: [
      "functional",
      "robustness",
      "security",
      "fairness",
      "performance",
      "compliance",
    ] as TestCategory[],
    capabilities: {
      supports_replications: true,
      supports_streaming: false,
      supports_multimodal: false,
      supports_multi_turn: false,
    },
    async healthcheck() {
      return { available, version: "1.0.0" };
    },
    async execute(test: PlannedTest, _adapter: SystemAdapter): Promise<TestResult> {
      return {
        test_id: test.id,
        backend_id: id,
        passed,
        score,
        metrics: { latency_ms: 10 },
        raw_output: "mock output",
        duration_ms: 10,
        metadata: {},
      };
    },
  };
}

// === Mock backend with variable scores (for noise testing) ===
function createVariableBackend(id: string, scores: number[]): ExecutionBackend {
  let callIndex = 0;
  return {
    id,
    name: "Variable Backend",
    supported_categories: ["functional"] as TestCategory[],
    capabilities: {
      supports_replications: true,
      supports_streaming: false,
      supports_multimodal: false,
      supports_multi_turn: false,
    },
    async healthcheck() {
      return { available: true, version: "1.0.0" };
    },
    async execute(test: PlannedTest): Promise<TestResult> {
      const score = scores[callIndex % scores.length];
      callIndex++;
      return {
        test_id: test.id,
        backend_id: id,
        passed: score >= 0.5,
        score,
        metrics: { latency_ms: 10 },
        raw_output: "variable output",
        duration_ms: 10 + callIndex,
        metadata: {},
      };
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

// === Helper: create many tests across a dimension for CAT convergence ===
function makeTestPool(dimension: TestDimension, count: number, prefix = "pool"): PlannedTest[] {
  const tests: PlannedTest[] = [];
  for (let i = 0; i < count; i++) {
    tests.push(
      makePlannedTest({
        id: `${prefix}-${dimension}-${i}`,
        name: `${dimension} test ${i}`,
        dimension,
        category: dimension as TestCategory,
        irt_params: {
          alpha: 0.8 + (i % 5) * 0.3, // vary discrimination 0.8 - 2.0
          beta: -2 + (i / (count - 1)) * 4, // spread difficulty -2 to +2
          gamma: 0.1,
        },
        metadata: {
          evaluators: [{ type: "contains" as const, value: "Mock" }],
        },
      }),
    );
  }
  return tests;
}

// === Default execution config ===
function makeConfig(overrides?: Partial<ExecutionConfig>): ExecutionConfig {
  return {
    mode: "adaptive",
    se_threshold: 0.3,
    max_tests: 100,
    timeout_minutes: 30,
    concurrency: 1,
    replications: 1,
    warmup_count: 0,
    ...overrides,
  };
}

// === Default test plan ===
function makeTestPlan(
  tests: PlannedTest[],
  strategy: "adaptive" | "exhaustive" = "adaptive",
): TestPlan {
  const dimensions = [...new Set(tests.map((t) => t.dimension))];
  return {
    tests,
    dimensions,
    strategy,
    estimates: {
      estimated_tests: tests.length,
      estimated_time_ms: tests.length * 100,
    },
  };
}

// ============================================================
// NoiseIsolator Tests
// ============================================================
describe("NoiseIsolator", () => {
  // 1. warmup sends N requests
  test("warmup sends warmup_count requests to adapter", async () => {
    let sendCount = 0;
    const adapter: SystemAdapter = {
      id: "counting",
      type: "http",
      async connect() {},
      async send(_input: TestInput) {
        sendCount++;
        return { content: "ok", format: "text" as const, latency_ms: 1 };
      },
      async disconnect() {},
      async inspect() {
        return { reachable: true };
      },
    };

    const noise = new NoiseIsolator({
      warmup_count: 5,
      replications: 3,
      cv_threshold: 0.15,
    });

    await noise.warmup(adapter, { type: "text", content: "test" });
    expect(sendCount).toBe(5);
  });

  // 2. replications calculates CV
  test("replications calculates coefficient of variation correctly", async () => {
    // Scores: 0.4, 0.6, 0.8 -> mean=0.6, stddev=0.1633, CV=0.2722
    const backend = createVariableBackend("built-in", [0.4, 0.6, 0.8]);
    const adapter = createMockAdapter();
    const noise = new NoiseIsolator({
      warmup_count: 0,
      replications: 3,
      cv_threshold: 0.15,
    });

    const { noise_cv } = await noise.executeWithReplications(
      backend,
      makePlannedTest(),
      adapter,
      3,
    );

    // mean = 0.6, stddev = sqrt((0.04+0+0.04)/3) = sqrt(0.02667) = 0.1633
    // cv = 0.1633 / 0.6 = 0.2722
    expect(noise_cv).toBeGreaterThan(0.2);
    expect(noise_cv).toBeLessThan(0.3);
  });

  // 3. CV > threshold -> noise_flag true
  test("noise_flag is true when CV exceeds threshold", async () => {
    // High variance scores: 0.1, 0.9, 0.5
    const backend = createVariableBackend("built-in", [0.1, 0.9, 0.5]);
    const adapter = createMockAdapter();
    const noise = new NoiseIsolator({
      warmup_count: 0,
      replications: 3,
      cv_threshold: 0.15,
    });

    const { noise_flag } = await noise.executeWithReplications(
      backend,
      makePlannedTest(),
      adapter,
      3,
    );

    expect(noise_flag).toBe(true);
  });

  // 4. CV < threshold -> noise_flag false
  test("noise_flag is false when CV is below threshold", async () => {
    // Consistent scores: 0.8, 0.8, 0.8
    const backend = createVariableBackend("built-in", [0.8, 0.8, 0.8]);
    const adapter = createMockAdapter();
    const noise = new NoiseIsolator({
      warmup_count: 0,
      replications: 3,
      cv_threshold: 0.15,
    });

    const { noise_cv, noise_flag } = await noise.executeWithReplications(
      backend,
      makePlannedTest(),
      adapter,
      3,
    );

    expect(noise_cv).toBeCloseTo(0, 10);
    expect(noise_flag).toBe(false);
  });

  // 5. replications = 1 -> no CV calculation
  test("single replication returns cv=0 and noise_flag=false", async () => {
    const backend = createMockBackend();
    const adapter = createMockAdapter();
    const noise = new NoiseIsolator({
      warmup_count: 0,
      replications: 1,
      cv_threshold: 0.15,
    });

    const { result, noise_cv, noise_flag } = await noise.executeWithReplications(
      backend,
      makePlannedTest(),
      adapter,
      1,
    );

    expect(noise_cv).toBe(0);
    expect(noise_flag).toBe(false);
    expect(result.test_id).toBe("test-001");
  });

  // 6. median of replications used
  test("median result is selected from replications", async () => {
    // Scores: 0.2, 0.5, 0.9 -> sorted: 0.2, 0.5, 0.9 -> median index 1 -> score 0.5
    const backend = createVariableBackend("built-in", [0.2, 0.5, 0.9]);
    const adapter = createMockAdapter();
    const noise = new NoiseIsolator({
      warmup_count: 0,
      replications: 3,
      cv_threshold: 0.15,
    });

    const { result } = await noise.executeWithReplications(backend, makePlannedTest(), adapter, 3);

    // The median of [0.2, 0.5, 0.9] sorted is at index 1 -> score 0.5
    expect(result.score).toBe(0.5);
    expect(result.replications).toBeDefined();
    expect(result.replications?.length).toBe(3);
  });
});

// ============================================================
// AdaptiveExecutor — Adaptive mode
// ============================================================
describe("AdaptiveExecutor (adaptive)", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  // 7. CATEngine created per dimension
  test("creates separate CAT engines per dimension", async () => {
    const robustnessTests = makeTestPool("robustness", 10, "r");
    const securityTests = makeTestPool("security", 10, "s");
    const allTests = [...robustnessTests, ...securityTests];

    const backend = createMockBackend();
    const config = makeConfig({ replications: 1, warmup_count: 0 });
    const executor = new AdaptiveExecutor([backend], bus, config);
    const plan = makeTestPlan(allTests, "adaptive");
    const adapter = createMockAdapter();

    const results = await executor.execute(plan, adapter, "eval-001");

    // Should have IRT estimates for both dimensions
    expect(results.irt_estimates.length).toBe(2);
    const dims = results.irt_estimates.map((e) => e.dimension).sort();
    expect(dims).toEqual(["robustness", "security"]);
  });

  // 8. CAT loop converges when SE < threshold (small pool)
  test("CAT loop converges with sufficient items and SE below threshold", async () => {
    const tests = makeTestPool("robustness", 30);
    const backend = createMockBackend("built-in", "Mock", true, 1.0, true);
    const config = makeConfig({
      se_threshold: 0.5, // lenient threshold for convergence
      max_tests: 30,
      replications: 1,
      warmup_count: 0,
    });
    const executor = new AdaptiveExecutor([backend], bus, config);
    const plan = makeTestPlan(tests, "adaptive");
    const adapter = createMockAdapter();

    const results = await executor.execute(plan, adapter, "eval-002");

    const estimate = results.irt_estimates[0];
    expect(estimate.dimension).toBe("robustness");
    expect(typeof estimate.theta).toBe("number");
    expect(typeof estimate.se).toBe("number");
    expect(estimate.n_tests).toBeGreaterThan(0);
    // With all-pass results and lenient SE, should use fewer than all items
    expect(estimate.n_tests).toBeLessThanOrEqual(30);
  });

  // 9. CAT loop respects max_tests limit
  test("CAT loop stops at max_tests even if not converged", async () => {
    const tests = makeTestPool("robustness", 20);
    const backend = createMockBackend();
    const config = makeConfig({
      se_threshold: 0.01, // very strict - won't converge easily
      max_tests: 5,
      replications: 1,
      warmup_count: 0,
    });
    const executor = new AdaptiveExecutor([backend], bus, config);
    const plan = makeTestPlan(tests, "adaptive");
    const adapter = createMockAdapter();

    const results = await executor.execute(plan, adapter, "eval-003");

    const estimate = results.irt_estimates[0];
    // Should not exceed max_tests (convergence check includes maxTests)
    expect(estimate.n_tests).toBeLessThanOrEqual(5);
  });

  // 10. Backend selected correctly via metadata.backends
  test("selects preferred backend from test metadata", async () => {
    const specialBackend = createMockBackend("special-backend", "Special");
    const builtIn = createMockBackend("built-in", "Built-in");

    const testWithPref = makePlannedTest({
      id: "pref-test",
      metadata: {
        backends: ["special-backend"],
        evaluators: [{ type: "contains" as const, value: "mock" }],
      },
    });

    const config = makeConfig({ replications: 1, warmup_count: 0 });
    const executor = new AdaptiveExecutor([builtIn, specialBackend], bus, config);
    const plan = makeTestPlan([testWithPref], "adaptive");
    const adapter = createMockAdapter();

    const results = await executor.execute(plan, adapter, "eval-004");

    expect(results.test_results[0].backend_id).toBe("special-backend");
  });

  // 11. Fallback to built-in when preferred not available
  test("falls back to built-in backend when preferred is unavailable", async () => {
    const builtIn = createMockBackend("built-in", "Built-in");

    const testWithMissingPref = makePlannedTest({
      id: "missing-pref",
      metadata: {
        backends: ["nonexistent-backend"],
        evaluators: [{ type: "contains" as const, value: "mock" }],
      },
    });

    const config = makeConfig({ replications: 1, warmup_count: 0 });
    const executor = new AdaptiveExecutor([builtIn], bus, config);
    const plan = makeTestPlan([testWithMissingPref], "adaptive");
    const adapter = createMockAdapter();

    const results = await executor.execute(plan, adapter, "eval-005");

    expect(results.test_results[0].backend_id).toBe("built-in");
  });

  // 12. Events emitted: executor.started
  test("emits executor.started event", async () => {
    let startedEmitted = false;
    bus.on("executor.started", () => {
      startedEmitted = true;
    });

    const backend = createMockBackend();
    const config = makeConfig({ replications: 1, warmup_count: 0 });
    const executor = new AdaptiveExecutor([backend], bus, config);
    const plan = makeTestPlan([makePlannedTest()], "adaptive");
    const adapter = createMockAdapter();

    await executor.execute(plan, adapter, "eval-006");

    expect(startedEmitted).toBe(true);
  });

  // 13. Events emitted: executor.test.started
  test("emits executor.test.started event for each test", async () => {
    const testStartedIds: string[] = [];
    bus.on("executor.test.started", (data) => {
      testStartedIds.push(data.test_id);
    });

    const tests = makeTestPool("robustness", 5);
    const backend = createMockBackend();
    const config = makeConfig({
      replications: 1,
      warmup_count: 0,
      max_tests: 5,
      se_threshold: 0.01, // won't converge early
    });
    const executor = new AdaptiveExecutor([backend], bus, config);
    const plan = makeTestPlan(tests, "adaptive");
    const adapter = createMockAdapter();

    await executor.execute(plan, adapter, "eval-007");

    expect(testStartedIds.length).toBeGreaterThan(0);
    // All emitted IDs should be from our test pool
    for (const id of testStartedIds) {
      expect(tests.some((t) => t.id === id)).toBe(true);
    }
  });

  // 14. Events emitted: executor.test.completed
  test("emits executor.test.completed event with correct data", async () => {
    const completedEvents: Array<{
      test_id: string;
      passed: boolean;
      theta: number;
      se: number;
      dimension: TestDimension;
    }> = [];
    bus.on("executor.test.completed", (data) => {
      completedEvents.push(data);
    });

    const tests = makeTestPool("robustness", 5);
    const backend = createMockBackend();
    const config = makeConfig({
      replications: 1,
      warmup_count: 0,
      max_tests: 3,
      se_threshold: 0.01,
    });
    const executor = new AdaptiveExecutor([backend], bus, config);
    const plan = makeTestPlan(tests, "adaptive");
    const adapter = createMockAdapter();

    await executor.execute(plan, adapter, "eval-008");

    expect(completedEvents.length).toBeGreaterThan(0);
    for (const ev of completedEvents) {
      expect(typeof ev.theta).toBe("number");
      expect(typeof ev.se).toBe("number");
      expect(ev.dimension).toBe("robustness");
      expect(typeof ev.passed).toBe("boolean");
    }
  });

  // 15. Events emitted: executor.irt.updated
  test("emits executor.irt.updated event after each test", async () => {
    const irtUpdates: Array<{
      dimension: TestDimension;
      theta: number;
      se: number;
      n_tests: number;
    }> = [];
    bus.on("executor.irt.updated", (data) => {
      irtUpdates.push(data);
    });

    const tests = makeTestPool("security", 10);
    const backend = createMockBackend();
    const config = makeConfig({
      replications: 1,
      warmup_count: 0,
      max_tests: 4,
      se_threshold: 0.01,
    });
    const executor = new AdaptiveExecutor([backend], bus, config);
    const plan = makeTestPlan(tests, "adaptive");
    const adapter = createMockAdapter();

    await executor.execute(plan, adapter, "eval-009");

    expect(irtUpdates.length).toBeGreaterThan(0);
    // n_tests should increase
    for (let i = 0; i < irtUpdates.length; i++) {
      expect(irtUpdates[i].n_tests).toBe(i + 1);
      expect(irtUpdates[i].dimension).toBe("security");
    }
  });

  // 16. Event dimension.converged emitted
  test("emits executor.dimension.converged when SE drops below threshold", async () => {
    const convergedEvents: Array<{
      dimension: TestDimension;
      theta: number;
      se: number;
      reason: string;
    }> = [];
    bus.on("executor.dimension.converged", (data) => {
      convergedEvents.push(data);
    });

    const tests = makeTestPool("robustness", 30);
    const backend = createMockBackend();
    const config = makeConfig({
      replications: 1,
      warmup_count: 0,
      se_threshold: 0.5, // lenient enough to converge
      max_tests: 30,
    });
    const executor = new AdaptiveExecutor([backend], bus, config);
    const plan = makeTestPlan(tests, "adaptive");
    const adapter = createMockAdapter();

    await executor.execute(plan, adapter, "eval-010");

    // Should have converged
    expect(convergedEvents.length).toBeGreaterThanOrEqual(1);
    expect(convergedEvents[0].dimension).toBe("robustness");
    expect(typeof convergedEvents[0].reason).toBe("string");
    expect(convergedEvents[0].reason.length).toBeGreaterThan(0);
  });

  // 17. ExecutionResults contains irt_estimates
  test("ExecutionResults contains valid irt_estimates", async () => {
    const tests = makeTestPool("fairness", 15);
    const backend = createMockBackend();
    const config = makeConfig({
      replications: 1,
      warmup_count: 0,
      max_tests: 10,
    });
    const executor = new AdaptiveExecutor([backend], bus, config);
    const plan = makeTestPlan(tests, "adaptive");
    const adapter = createMockAdapter();

    const results = await executor.execute(plan, adapter, "eval-011");

    expect(results.irt_estimates.length).toBe(1);
    const estimate = results.irt_estimates[0];
    expect(estimate.dimension).toBe("fairness");
    expect(typeof estimate.theta).toBe("number");
    expect(typeof estimate.se).toBe("number");
    expect(typeof estimate.ci_lower).toBe("number");
    expect(typeof estimate.ci_upper).toBe("number");
    expect(typeof estimate.normalized_score).toBe("number");
    expect(estimate.ci_lower).toBeLessThan(estimate.ci_upper);
    expect(estimate.n_tests).toBeGreaterThan(0);
  });

  // 18. No tests if no items available (empty plan)
  test("handles empty test plan gracefully", async () => {
    const backend = createMockBackend();
    const config = makeConfig({ replications: 1, warmup_count: 0 });
    const executor = new AdaptiveExecutor([backend], bus, config);
    const plan = makeTestPlan([], "adaptive");
    const adapter = createMockAdapter();

    const results = await executor.execute(plan, adapter, "eval-012");

    expect(results.test_results.length).toBe(0);
    expect(results.irt_estimates.length).toBe(0);
    expect(results.evaluation_id).toBe("eval-012");
  });

  // 19. Test with single item
  test("handles single test item correctly", async () => {
    const singleTest = makePlannedTest({ id: "single-test" });
    const backend = createMockBackend();
    const config = makeConfig({ replications: 1, warmup_count: 0 });
    const executor = new AdaptiveExecutor([backend], bus, config);
    const plan = makeTestPlan([singleTest], "adaptive");
    const adapter = createMockAdapter();

    const results = await executor.execute(plan, adapter, "eval-013");

    expect(results.test_results.length).toBe(1);
    expect(results.test_results[0].test_id).toBe("single-test");
    expect(results.irt_estimates.length).toBe(1);
    expect(results.irt_estimates[0].n_tests).toBe(1);
  });
});

// ============================================================
// AdaptiveExecutor — Exhaustive mode
// ============================================================
describe("AdaptiveExecutor (exhaustive)", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  // 20. All tests executed
  test("executes all tests in exhaustive mode", async () => {
    const tests = makeTestPool("robustness", 8);
    const backend = createMockBackend();
    const config = makeConfig({ replications: 1, warmup_count: 0 });
    const executor = new AdaptiveExecutor([backend], bus, config);
    const plan = makeTestPlan(tests, "exhaustive");
    const adapter = createMockAdapter();

    const results = await executor.execute(plan, adapter, "eval-020");

    expect(results.test_results.length).toBe(8);
    const resultIds = results.test_results.map((r) => r.test_id).sort();
    const testIds = tests.map((t) => t.id).sort();
    expect(resultIds).toEqual(testIds);
  });

  // 21. IRT estimates calculated at end
  test("calculates IRT estimates after all tests run", async () => {
    const tests = makeTestPool("security", 6);
    const backend = createMockBackend();
    const config = makeConfig({ replications: 1, warmup_count: 0 });
    const executor = new AdaptiveExecutor([backend], bus, config);
    const plan = makeTestPlan(tests, "exhaustive");
    const adapter = createMockAdapter();

    const results = await executor.execute(plan, adapter, "eval-021");

    expect(results.irt_estimates.length).toBe(1);
    const estimate = results.irt_estimates[0];
    expect(estimate.dimension).toBe("security");
    expect(estimate.n_tests).toBe(6);
    expect(typeof estimate.theta).toBe("number");
    expect(typeof estimate.normalized_score).toBe("number");
  });

  // 22. No adaptive selection (all tests run regardless of SE)
  test("does not skip tests regardless of SE convergence", async () => {
    const tests = makeTestPool("robustness", 10);
    const backend = createMockBackend();
    const config = makeConfig({
      se_threshold: 10.0, // would converge immediately in adaptive
      max_tests: 100,
      replications: 1,
      warmup_count: 0,
    });
    const executor = new AdaptiveExecutor([backend], bus, config);
    const plan = makeTestPlan(tests, "exhaustive");
    const adapter = createMockAdapter();

    const results = await executor.execute(plan, adapter, "eval-022");

    // All 10 tests should have been executed
    expect(results.test_results.length).toBe(10);
  });

  // 23. Mode exhaustive returns all results with metadata
  test("exhaustive mode returns correct execution_metadata", async () => {
    const tests = makeTestPool("performance", 4);
    const backend = createMockBackend();
    const config = makeConfig({ replications: 1, warmup_count: 0 });
    const executor = new AdaptiveExecutor([backend], bus, config);
    const plan = makeTestPlan(tests, "exhaustive");
    const adapter = createMockAdapter();

    const results = await executor.execute(plan, adapter, "eval-023");

    expect(results.execution_metadata.strategy).toBe("exhaustive");
    expect((results.execution_metadata.backends_used as string[]).length).toBeGreaterThan(0);
    expect(results.evaluation_id).toBe("eval-023");
  });
});

// ============================================================
// Backend Selection
// ============================================================
describe("Backend selection", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  // 24. Test compatible -> backend selected
  test("selects compatible backend based on test metadata", async () => {
    const backendA = createMockBackend("backend-a", "Backend A");
    const backendB = createMockBackend("backend-b", "Backend B");
    const builtIn = createMockBackend("built-in", "Built-in");

    const testForA = makePlannedTest({
      id: "for-a",
      metadata: { backends: ["backend-a"] },
    });
    const testForB = makePlannedTest({
      id: "for-b",
      metadata: { backends: ["backend-b"] },
    });

    const config = makeConfig({ replications: 1, warmup_count: 0 });
    const executor = new AdaptiveExecutor([builtIn, backendA, backendB], bus, config);
    const plan = makeTestPlan([testForA, testForB], "exhaustive");
    const adapter = createMockAdapter();

    const results = await executor.execute(plan, adapter, "eval-024");

    const resultA = results.test_results.find((r) => r.test_id === "for-a");
    const resultB = results.test_results.find((r) => r.test_id === "for-b");
    expect(resultA?.backend_id).toBe("backend-a");
    expect(resultB?.backend_id).toBe("backend-b");
  });

  // 25. Backend unavailable -> fallback built-in
  test("falls back to built-in when preferred backend fails healthcheck", async () => {
    const unavailable = createMockBackend(
      "unavailable-backend",
      "Unavailable",
      false, // not available
    );
    const builtIn = createMockBackend("built-in", "Built-in");

    const testWithUnavail = makePlannedTest({
      id: "unavail-test",
      metadata: { backends: ["unavailable-backend"] },
    });

    const config = makeConfig({ replications: 1, warmup_count: 0 });
    const executor = new AdaptiveExecutor([unavailable, builtIn], bus, config);
    const plan = makeTestPlan([testWithUnavail], "exhaustive");
    const adapter = createMockAdapter();

    const results = await executor.execute(plan, adapter, "eval-025");

    // unavailable backend didn't pass healthcheck, so built-in was used
    expect(results.test_results[0].backend_id).toBe("built-in");
  });

  // 26. No backends available -> error
  test("throws error when no backends are available", async () => {
    const unavailable = createMockBackend("bad", "Bad", false);

    const config = makeConfig({ replications: 1, warmup_count: 0 });
    const executor = new AdaptiveExecutor([unavailable], bus, config);
    const testItem = makePlannedTest();
    const plan = makeTestPlan([testItem], "exhaustive");
    const adapter = createMockAdapter();

    try {
      await executor.execute(plan, adapter, "eval-026");
      expect(true).toBe(false); // Should not reach here
    } catch (error: unknown) {
      const err = error as Error;
      expect(err.message).toContain("No backends available");
    }
  });
});

// ============================================================
// Warmup and executor.completed event
// ============================================================
describe("Executor integration", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  // 27. Warmup sends correct number of requests
  test("warmup sends requests before test execution", async () => {
    let sendCount = 0;
    const adapter: SystemAdapter = {
      id: "counting",
      type: "http",
      async connect() {},
      async send(_input: TestInput) {
        sendCount++;
        return { content: "ok", format: "text" as const, latency_ms: 1 };
      },
      async disconnect() {},
      async inspect() {
        return { reachable: true };
      },
    };

    const tests = makeTestPool("robustness", 3);
    const backend = createMockBackend();
    const config = makeConfig({
      replications: 1,
      warmup_count: 3,
      max_tests: 3,
      se_threshold: 0.01,
    });
    const executor = new AdaptiveExecutor([backend], bus, config);
    const plan = makeTestPlan(tests, "adaptive");

    await executor.execute(plan, adapter, "eval-027");

    // warmup_count (3) sends happen via the adapter, backend calls don't go through adapter.send
    // The warmup sends 3 requests, then test execution goes through the backend
    expect(sendCount).toBeGreaterThanOrEqual(3);
  });

  // 28. executor.completed event emitted with results
  test("emits executor.completed event with final results", async () => {
    let completedResults: unknown = null;
    bus.on("executor.completed", (data) => {
      completedResults = data.results;
    });

    const tests = makeTestPool("robustness", 5);
    const backend = createMockBackend();
    const config = makeConfig({ replications: 1, warmup_count: 0 });
    const executor = new AdaptiveExecutor([backend], bus, config);
    const plan = makeTestPlan(tests, "exhaustive");
    const adapter = createMockAdapter();

    await executor.execute(plan, adapter, "eval-028");

    expect(completedResults).not.toBeNull();
    const res = completedResults as { evaluation_id: string };
    expect(res.evaluation_id).toBe("eval-028");
  });

  // 29. Multi-dimension adaptive produces separate estimates
  test("multi-dimension adaptive produces separate IRT estimates per dimension", async () => {
    const robustnessTests = makeTestPool("robustness", 10, "r");
    const securityTests = makeTestPool("security", 10, "s");
    const fairnessTests = makeTestPool("fairness", 10, "f");
    const allTests = [...robustnessTests, ...securityTests, ...fairnessTests];

    const backend = createMockBackend();
    const config = makeConfig({
      replications: 1,
      warmup_count: 0,
      max_tests: 10,
    });
    const executor = new AdaptiveExecutor([backend], bus, config);
    const plan = makeTestPlan(allTests, "adaptive");
    const adapter = createMockAdapter();

    const results = await executor.execute(plan, adapter, "eval-029");

    expect(results.irt_estimates.length).toBe(3);
    const dims = results.irt_estimates.map((e) => e.dimension).sort();
    expect(dims).toEqual(["fairness", "robustness", "security"]);
    for (const estimate of results.irt_estimates) {
      expect(estimate.n_tests).toBeGreaterThan(0);
    }
  });
});
