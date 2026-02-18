import { beforeEach, describe, expect, test } from "bun:test";
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
  SystemProfile,
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

// Simple mock adapter that echos back
class MockAdapter implements SystemAdapter {
  id = "mock";
  type = "http" as const;
  connected = false;

  async connect(_config: TargetConfig): Promise<void> {
    this.connected = true;
  }
  async send(_input: TestInput): Promise<SystemOutput> {
    return {
      content: "This is a test response with some content for evaluation",
      format: "text",
      latency_ms: 50,
    };
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  async inspect(): Promise<SystemMetadata> {
    return { reachable: true };
  }
}

function createTestDeps(bus: EventBus): PipelineDeps {
  const db = createTestDatabase();
  runMigrations(db);
  const adapter = new MockAdapter();
  const library = new TestLibrary();
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

  return {
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
}

describe("PipelineOrchestrator", () => {
  let bus: EventBus;
  let deps: PipelineDeps;
  let pipeline: PipelineOrchestrator;

  const testConfig: PipelineConfig = {
    target: {
      url: "http://localhost:9999",
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
  };

  beforeEach(async () => {
    bus = new EventBus();
    deps = createTestDeps(bus);
    // Load built-in library so there are tests available
    await deps.library.loadBuiltIn();
    pipeline = new PipelineOrchestrator(deps);
  });

  test("on/off delegate to bus correctly", () => {
    let callCount = 0;
    const handler = () => {
      callCount++;
    };

    pipeline.on("mapper.standard.loaded", handler);
    bus.emit("mapper.standard.loaded", { standard: "eu-ai-act" });
    expect(callCount).toBe(1);

    pipeline.off("mapper.standard.loaded", handler);
    bus.emit("mapper.standard.loaded", { standard: "nist-rmf" });
    expect(callCount).toBe(1);
  });

  test("introspect returns a SystemProfile", async () => {
    await (deps.adapter as MockAdapter).connect(testConfig.target);
    const profile = await pipeline.introspect({
      url: "http://localhost:9999",
      adapter: "http",
      system_type: "chatbot",
    });
    expect(profile.system_type).toBe("chatbot");
    expect(profile.detection_confidence).toBe(1.0);
  });

  test("map returns a ComplianceReport", async () => {
    const profile: SystemProfile = {
      id: "test",
      detected_at: new Date().toISOString(),
      system_type: "chatbot",
      detection_confidence: 1.0,
      detection_methods: [],
      input_interfaces: [{ type: "text", format: "json" }],
      output_interfaces: [{ type: "text", format: "text" }],
      capabilities: ["chatbot"],
      dependencies: [],
      adapter: testConfig.target,
    };

    const report = await pipeline.map(profile, {
      jurisdiction: "EU",
      risk_classification: "high-risk",
      sector: "general",
      standards: ["eu-ai-act"],
      exclusions: [],
    });

    expect(report.jurisdiction).toBe("EU");
    expect(report.risk_classification).toBe("high-risk");
    expect(report.standards.length).toBeGreaterThanOrEqual(1);
  });

  test("generate returns a TestPlan", async () => {
    const profile: SystemProfile = {
      id: "test",
      detected_at: new Date().toISOString(),
      system_type: "chatbot",
      detection_confidence: 1.0,
      detection_methods: [],
      input_interfaces: [{ type: "text", format: "json" }],
      output_interfaces: [{ type: "text", format: "text" }],
      capabilities: ["chatbot"],
      dependencies: [],
      adapter: testConfig.target,
    };

    const plan = await pipeline.generate(profile);
    expect(plan.tests.length).toBeGreaterThan(0);
    expect(plan.dimensions.length).toBeGreaterThan(0);
  });
});
