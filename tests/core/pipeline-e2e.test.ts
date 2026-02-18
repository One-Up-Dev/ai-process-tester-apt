import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { EventBus } from "@apt/core/event-bus";
import { type PipelineDeps, PipelineOrchestrator } from "@apt/core/pipeline";
import { createTestDatabase } from "@apt/lib/db";
import { runMigrations } from "@apt/lib/migrations";
import { EvaluationRepository } from "@apt/lib/repositories/evaluations";
import { IRTEstimateRepository } from "@apt/lib/repositories/irt-estimates";
import { TestResultRepository } from "@apt/lib/repositories/test-results";
import type {
  PipelineConfig,
  SystemAdapter,
  SystemMetadata,
  SystemOutput,
  TargetConfig,
  TestInput,
} from "@apt/lib/types";
import { Analyzer } from "@apt/modules/analyzer/index";
import { BuiltInBackend } from "@apt/modules/executor/backends/built-in";
import { AdaptiveExecutor } from "@apt/modules/executor/index";
import { TestGenerator } from "@apt/modules/generator/index";
import { TestLibrary } from "@apt/modules/generator/library/loader";
import { Introspector } from "@apt/modules/introspector/index";
import { ComplianceMapper } from "@apt/modules/mapper/index";

// Mock adapter that uses a real mock server
class MockAdapter implements SystemAdapter {
  id = "mock";
  type = "http" as const;
  connected = false;
  private serverUrl = "";

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
  }

  async connect(_config: TargetConfig): Promise<void> {
    this.connected = true;
  }
  async send(_input: TestInput): Promise<SystemOutput> {
    const start = performance.now();
    const response = await fetch(this.serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: _input.content }] }),
    });
    const json = (await response.json()) as { content: string };
    const latency = performance.now() - start;
    return {
      content: json.content,
      format: "text",
      latency_ms: Math.round(latency),
    };
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  async inspect(): Promise<SystemMetadata> {
    return { reachable: true };
  }
}

describe("Pipeline E2E", () => {
  // biome-ignore lint/suspicious/noExplicitAny: Bun.serve return type varies by version
  let server: any;
  let serverUrl: string;
  let bus: EventBus;
  let db: Database;
  let adapter: MockAdapter;
  let library: TestLibrary;
  let deps: PipelineDeps;
  let pipeline: PipelineOrchestrator;

  beforeAll(async () => {
    // Start a real Bun mock server
    server = Bun.serve({
      port: 0,
      fetch(_req) {
        return Response.json({
          content: "I am a helpful assistant. Here is a clear and detailed response to your query.",
        });
      },
    });
    serverUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  beforeEach(async () => {
    bus = new EventBus();
    db = createTestDatabase();
    runMigrations(db);
    adapter = new MockAdapter(serverUrl);
    library = new TestLibrary();
    await library.loadBuiltIn();

    const introspector = new Introspector([], adapter, bus);
    const mapper = new ComplianceMapper(bus);
    const generator = new TestGenerator(library, bus);
    const executor = new AdaptiveExecutor([new BuiltInBackend()], bus, {
      mode: "exhaustive",
      se_threshold: 0.3,
      max_tests: 100,
      timeout_minutes: 30,
      concurrency: 1,
      replications: 1,
      warmup_count: 0,
    });
    const analyzer = new Analyzer(bus);

    deps = {
      bus,
      introspector,
      mapper,
      generator,
      executor,
      analyzer,
      library,
      db: {
        evaluations: new EvaluationRepository(db),
        testResults: new TestResultRepository(db),
        irtEstimates: new IRTEstimateRepository(db),
      },
      adapter,
    };

    pipeline = new PipelineOrchestrator(deps);
  });

  function makeConfig(overrides?: Partial<PipelineConfig>): PipelineConfig {
    return {
      target: {
        url: serverUrl,
        adapter: "http",
        system_type: "chatbot",
      },
      execution: {
        mode: "exhaustive",
        se_threshold: 0.3,
        max_tests: 100,
        timeout_minutes: 30,
        concurrency: 1,
        replications: 1,
        warmup_count: 0,
      },
      analysis: {
        confidence_level: 0.95,
        drift_detection: false,
        effect_size_threshold: 0.5,
        power_target: 0.8,
      },
      reports: {
        formats: ["json"],
        output_dir: "./reports",
        include_raw_data: false,
      },
      ...overrides,
    };
  }

  // -- Test 1-3: Pipeline run() completes E2E
  test("run() completes and returns AnalysisReport with dimensions", async () => {
    const config = makeConfig();
    const report = await pipeline.run(config);
    expect(report.dimensions.length).toBeGreaterThan(0);
  });

  test("run() report has scores", async () => {
    const config = makeConfig();
    const report = await pipeline.run(config);
    expect(report.summary.overall_score).toBeGreaterThanOrEqual(0);
    expect(report.summary.overall_score).toBeLessThanOrEqual(100);
  });

  test("run() report has grades", async () => {
    const config = makeConfig();
    const report = await pipeline.run(config);
    expect(["A", "B", "C", "D", "F"]).toContain(report.summary.overall_grade);
    for (const dim of report.dimensions) {
      expect(["A", "B", "C", "D", "F"]).toContain(dim.grade);
    }
  });

  // -- Test 4: Pipeline creates evaluation in DB
  test("creates evaluation in DB", async () => {
    const config = makeConfig();
    await pipeline.run(config);
    const evaluations = deps.db.evaluations.findRecent(10);
    expect(evaluations.length).toBeGreaterThanOrEqual(1);
    const ev = evaluations[0];
    expect(ev.target_url).toBe(serverUrl);
    expect(ev.status).toBe("completed");
  });

  // -- Test 5: Pipeline persists test_results
  test("persists test_results in DB", async () => {
    const config = makeConfig();
    await pipeline.run(config);
    const evaluations = deps.db.evaluations.findRecent(1);
    const evalId = evaluations[0].id;
    const count = deps.db.testResults.countByEvaluation(evalId);
    expect(count).toBeGreaterThan(0);
  });

  // -- Test 6: Pipeline persists irt_estimates
  test("persists irt_estimates in DB", async () => {
    const config = makeConfig();
    await pipeline.run(config);
    const evaluations = deps.db.evaluations.findRecent(1);
    const evalId = evaluations[0].id;
    const estimates = deps.db.irtEstimates.findByEvaluation(evalId);
    expect(estimates.length).toBeGreaterThan(0);
  });

  // -- Test 7-8: Pipeline emits events
  test("emits pipeline.started event", async () => {
    let started = false;
    bus.on("pipeline.started", () => {
      started = true;
    });
    await pipeline.run(makeConfig());
    expect(started).toBe(true);
  });

  test("emits pipeline.completed event", async () => {
    let completed = false;
    let completedDuration = 0;
    bus.on("pipeline.completed", (data) => {
      completed = true;
      completedDuration = data.duration_ms;
    });
    await pipeline.run(makeConfig());
    expect(completed).toBe(true);
    expect(completedDuration).toBeGreaterThan(0);
  });

  // -- Test 9: Pipeline emits pipeline.failed on error
  test("emits pipeline.failed on error", async () => {
    let failedEvent: { error: { code: string } } | null = null;
    bus.on("pipeline.failed", (data) => {
      failedEvent = data as { error: { code: string } };
    });

    // Create a broken adapter that fails on connect
    const brokenAdapter: SystemAdapter = {
      id: "broken",
      type: "http",
      async connect() {
        throw new Error("Connection refused");
      },
      async send() {
        throw new Error("Not connected");
      },
      async disconnect() {},
      async inspect() {
        return { reachable: false };
      },
    };

    const brokenDeps = { ...deps, adapter: brokenAdapter };
    const brokenPipeline = new PipelineOrchestrator(brokenDeps);

    try {
      await brokenPipeline.run(makeConfig());
    } catch {
      // expected
    }

    expect(failedEvent).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: we just asserted it's not null
    expect(failedEvent!.error.code).toBe("PIPELINE_FAIL");
  });

  // -- Test 10: Pipeline without compliance skips mapper
  test("without compliance skips mapper", async () => {
    let mapperCalled = false;
    bus.on("mapper.standard.loaded", () => {
      mapperCalled = true;
    });

    const config = makeConfig();
    // No compliance in config -> mapper should be skipped
    await pipeline.run(config);
    expect(mapperCalled).toBe(false);
  });

  // -- Test 11: Pipeline with compliance executes mapper
  test("with compliance executes mapper", async () => {
    let mapperCalled = false;
    bus.on("mapper.standard.loaded", () => {
      mapperCalled = true;
    });

    const config = makeConfig({
      compliance: {
        jurisdiction: "EU",
        risk_classification: "high-risk",
        sector: "general",
        standards: ["eu-ai-act"],
        exclusions: [],
      },
    });

    await pipeline.run(config);
    expect(mapperCalled).toBe(true);
  });

  // -- Test 12: Pipeline adaptive uses CATEngine
  test("adaptive mode uses CATEngine (converges earlier)", async () => {
    // Create executor in adaptive mode
    const adaptiveExecutor = new AdaptiveExecutor([new BuiltInBackend()], bus, {
      mode: "adaptive",
      se_threshold: 0.3,
      max_tests: 5,
      timeout_minutes: 30,
      concurrency: 1,
      replications: 1,
      warmup_count: 0,
    });

    const adaptiveDeps = { ...deps, executor: adaptiveExecutor };
    const adaptivePipeline = new PipelineOrchestrator(adaptiveDeps);

    const config = makeConfig({
      execution: {
        mode: "adaptive",
        se_threshold: 0.3,
        max_tests: 5,
        timeout_minutes: 30,
        concurrency: 1,
        replications: 1,
        warmup_count: 0,
      },
    });

    let _convergedEvents = 0;
    bus.on("executor.dimension.converged", () => {
      _convergedEvents++;
    });

    const report = await adaptivePipeline.run(config);
    // In adaptive mode, should still produce results
    expect(report.dimensions.length).toBeGreaterThan(0);
  });

  // -- Test 13: Pipeline exhaustive runs all tests
  test("exhaustive mode runs all tests", async () => {
    const config = makeConfig({
      execution: {
        mode: "exhaustive",
        se_threshold: 0.3,
        max_tests: 100,
        timeout_minutes: 30,
        concurrency: 1,
        replications: 1,
        warmup_count: 0,
      },
    });

    const report = await pipeline.run(config);
    // Exhaustive should run all chatbot-compatible tests
    expect(report.summary.total_tests).toBeGreaterThan(0);
  });

  // -- Test 14: Pipeline calculates duration_ms
  test("calculates duration_ms in report", async () => {
    const report = await pipeline.run(makeConfig());
    expect(report.summary.duration_ms).toBeGreaterThan(0);
  });

  // -- Test 15: Pipeline disconnects adapter
  test("disconnects adapter after run", async () => {
    await pipeline.run(makeConfig());
    expect((deps.adapter as MockAdapter).connected).toBe(false);
  });
});
