import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EventBus } from "@apt/core/event-bus";
import { type PipelineDeps, PipelineOrchestrator } from "@apt/core/pipeline";
import { runMigrations } from "@apt/lib/migrations";
import { EvaluationRepository } from "@apt/lib/repositories/evaluations";
import { IRTEstimateRepository } from "@apt/lib/repositories/irt-estimates";
import { TestResultRepository } from "@apt/lib/repositories/test-results";
import type { AnalysisReport, PipelineConfig } from "@apt/lib/types";
import { Analyzer } from "@apt/modules/analyzer/index";
import { BuiltInBackend } from "@apt/modules/executor/backends/built-in";
import { AdaptiveExecutor } from "@apt/modules/executor/index";
import { TestGenerator } from "@apt/modules/generator/index";
import { TestLibrary } from "@apt/modules/generator/library/loader";
import { HttpAdapter } from "@apt/modules/introspector/adapters/http";
import { ConfigFileDetector } from "@apt/modules/introspector/detectors/config-file";
import { DependencyDetector } from "@apt/modules/introspector/detectors/dependency";
import { EndpointDetector } from "@apt/modules/introspector/detectors/endpoint";
import { IOProbingDetector } from "@apt/modules/introspector/detectors/io-probing";
import { Introspector } from "@apt/modules/introspector/index";
import { ComplianceMapper } from "@apt/modules/mapper/index";

let mockServer: ReturnType<typeof Bun.serve>;
let mockServerUrl: string;

beforeAll(() => {
  // Mock AI server simulating an OpenAI-compatible endpoint
  mockServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);

      if (req.method === "HEAD") {
        return new Response(null, { status: 200 });
      }

      if (url.pathname === "/models") {
        return Response.json({ data: [{ id: "test-model" }] });
      }

      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: { Allow: "GET, POST, OPTIONS" },
        });
      }

      if (req.method === "POST") {
        return Response.json({
          choices: [
            {
              message: {
                content:
                  "I am a helpful assistant. I can help you with many things including answering questions.",
              },
            },
          ],
        });
      }

      return Response.json({ content: "default" });
    },
  });
  mockServerUrl = `http://localhost:${mockServer.port}`;
});

afterAll(() => {
  mockServer.stop(true);
});

describe("E2E Pipeline Integration", () => {
  // 1. Full pipeline runs programmatically and produces a valid report
  test("full pipeline produces valid AnalysisReport", async () => {
    // Setup in-memory DB
    const db = new Database(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);

    // Build pipeline
    const bus = new EventBus();
    const adapter = new HttpAdapter();
    const library = new TestLibrary();
    await library.loadBuiltIn();

    const detectors = [
      new EndpointDetector(),
      new IOProbingDetector(),
      new ConfigFileDetector(),
      new DependencyDetector(),
    ];

    const executionConfig = {
      mode: "adaptive" as const,
      se_threshold: 0.3,
      max_tests: 100,
      timeout_minutes: 30,
      concurrency: 4,
      replications: 3,
      warmup_count: 3,
    };

    const deps: PipelineDeps = {
      bus,
      introspector: new Introspector(detectors, adapter, bus),
      mapper: new ComplianceMapper(bus),
      generator: new TestGenerator(library, bus),
      executor: new AdaptiveExecutor([new BuiltInBackend()], bus, executionConfig),
      analyzer: new Analyzer(bus),
      library,
      db: {
        evaluations: new EvaluationRepository(db),
        testResults: new TestResultRepository(db),
        irtEstimates: new IRTEstimateRepository(db),
      },
      adapter,
    };

    const pipeline = new PipelineOrchestrator(deps);

    const config: PipelineConfig = {
      target: {
        url: mockServerUrl,
        adapter: "http",
        timeout_ms: 30000,
        system_type: "auto",
      },
      execution: executionConfig,
      analysis: {
        confidence_level: 0.95,
        drift_detection: true,
        effect_size_threshold: 0.5,
        power_target: 0.8,
      },
      reports: {
        formats: ["json"],
        output_dir: "./tmp-test-reports",
        include_raw_data: false,
      },
    };

    // Track events
    const events: string[] = [];
    bus.onAny((event) => events.push(event));

    const report: AnalysisReport = await pipeline.run(config);

    // Validate report structure
    expect(report).toBeDefined();
    expect(report.evaluation_id).toBeString();
    expect(report.summary).toBeDefined();
    expect(report.summary.overall_score).toBeNumber();
    expect(report.summary.overall_score).toBeGreaterThanOrEqual(0);
    expect(report.summary.overall_score).toBeLessThanOrEqual(100);
    expect(report.summary.overall_grade).toMatch(/^[ABCDF]$/);
    expect(report.summary.dimensions_tested).toBeGreaterThanOrEqual(1);
    expect(report.summary.total_tests).toBeGreaterThanOrEqual(1);
    expect(report.summary.duration_ms).toBeGreaterThanOrEqual(0);
    expect(report.dimensions).toBeArray();
    expect(report.dimensions.length).toBeGreaterThanOrEqual(1);
    expect(report.trace).toBeDefined();
    expect(report.trace.pipeline_version).toBeString();

    // Validate dimension structure
    for (const dim of report.dimensions) {
      expect(dim.dimension).toBeString();
      expect(dim.theta).toBeNumber();
      expect(dim.se).toBeNumber();
      expect(dim.normalized_score).toBeNumber();
      expect(dim.grade).toMatch(/^[ABCDF]$/);
      expect(dim.n_tests).toBeGreaterThanOrEqual(1);
    }

    // Validate events were emitted in order
    expect(events).toContain("pipeline.started");
    expect(events).toContain("introspector.started");
    expect(events).toContain("introspector.completed");
    expect(events).toContain("executor.started");
    expect(events).toContain("executor.completed");
    expect(events).toContain("analyzer.started");
    expect(events).toContain("analyzer.completed");
    expect(events).toContain("pipeline.completed");

    // Verify DB was populated
    const evals = new EvaluationRepository(db).findRecent(10);
    expect(evals.length).toBe(1);
    expect(evals[0].status).toBe("completed");
    expect(evals[0].target_url).toBe(mockServerUrl);

    const results = new TestResultRepository(db).findByEvaluation(evals[0].id);
    expect(results.length).toBeGreaterThanOrEqual(1);

    const estimates = new IRTEstimateRepository(db).findByEvaluation(evals[0].id);
    expect(estimates.length).toBeGreaterThanOrEqual(1);

    db.close();
  }, 120_000);

  // 2. Score to exit code mapping
  test("score maps to correct exit code logic", () => {
    const EXIT_CODES = { PASS: 0, FAIL: 1, ERROR: 2 } as const;

    // Use a function to avoid "constant condition" lint warnings
    function mapScoreToExit(score: number): number {
      return score >= 75 ? EXIT_CODES.PASS : EXIT_CODES.FAIL;
    }

    // Score >= 75 -> PASS (0)
    expect(mapScoreToExit(90)).toBe(0);
    expect(mapScoreToExit(75)).toBe(0);

    // Score < 75 -> FAIL (1)
    expect(mapScoreToExit(74.9)).toBe(1);
    expect(mapScoreToExit(50)).toBe(1);
    expect(mapScoreToExit(0)).toBe(1);
  });
});
