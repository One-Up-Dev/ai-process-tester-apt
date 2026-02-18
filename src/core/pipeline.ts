import type { EvaluationRepository } from "@apt/lib/repositories/evaluations";
import type { IRTEstimateRepository } from "@apt/lib/repositories/irt-estimates";
import type { TestResultRepository } from "@apt/lib/repositories/test-results";
import type {
  AnalysisReport,
  ComplianceConfig,
  ComplianceReport,
  ExecutionResults,
  Pipeline,
  PipelineConfig,
  SystemAdapter,
  SystemProfile,
  TargetConfig,
  TestPlan,
} from "@apt/lib/types";
import type { Analyzer } from "@apt/modules/analyzer/index";
import type { AdaptiveExecutor } from "@apt/modules/executor/index";
import type { TestGenerator } from "@apt/modules/generator/index";
import type { TestLibrary } from "@apt/modules/generator/library/loader";
import type { Introspector } from "@apt/modules/introspector/index";
import type { ComplianceMapper } from "@apt/modules/mapper/index";
import type { APTEventMap, EventBus } from "./event-bus";

export interface PipelineDeps {
  bus: EventBus;
  introspector: Introspector;
  mapper: ComplianceMapper;
  generator: TestGenerator;
  executor: AdaptiveExecutor;
  analyzer: Analyzer;
  library: TestLibrary;
  db: {
    evaluations: EvaluationRepository;
    testResults: TestResultRepository;
    irtEstimates: IRTEstimateRepository;
  };
  adapter: SystemAdapter;
}

export class PipelineOrchestrator implements Pipeline {
  private config: PipelineConfig | null = null;

  constructor(private deps: PipelineDeps) {}

  private get bus() {
    return this.deps.bus;
  }

  async run(config: PipelineConfig): Promise<AnalysisReport> {
    const startTime = Date.now();
    this.config = config;
    this.bus.emit("pipeline.started", { config });

    try {
      // 1. Create evaluation in DB
      const evaluationId = crypto.randomUUID();
      this.deps.db.evaluations.create({
        id: evaluationId,
        target_url: config.target.url,
        system_type: config.target.system_type ?? "auto",
        system_profile: null,
        compliance_report: null,
        config: JSON.stringify(config),
        mode: config.execution.mode,
        status: "running",
        started_at: new Date().toISOString(),
        completed_at: null,
        duration_ms: null,
      });

      // 2. Introspect
      await this.deps.adapter.connect(config.target);
      const profile = await this.introspect(config.target);

      // 3. Map (optional)
      let compliance: ComplianceReport | undefined;
      if (config.compliance) {
        compliance = await this.map(profile, config.compliance);
      }

      // 4. Generate
      const plan = await this.generate(profile, compliance);

      // 5. Execute
      const results = await this.execute(plan, this.deps.adapter, evaluationId);
      results.system_profile = profile;
      results.evaluation_id = evaluationId;
      results.planned_tests = plan.tests;

      // 6. Persist results
      // Build lookup map from plan for dimension/category
      const testMeta = new Map(
        plan.tests.map((t) => [t.id, { dimension: t.dimension, category: t.category }]),
      );

      for (const tr of results.test_results) {
        const meta = testMeta.get(tr.test_id);
        this.deps.db.testResults.create({
          id: crypto.randomUUID(),
          evaluation_id: evaluationId,
          test_id: tr.test_id,
          dimension: meta?.dimension ?? "functional",
          category: meta?.category ?? "functional",
          backend_id: tr.backend_id,
          passed: tr.passed ? 1 : 0,
          score: tr.score,
          metrics: JSON.stringify(tr.metrics),
          raw_input: null,
          raw_output: tr.raw_output,
          duration_ms: tr.duration_ms,
          replications: tr.replications ? JSON.stringify(tr.replications) : null,
          noise_cv: (tr.metadata?.noise_cv as number) ?? null,
          noise_flag: (tr.metadata?.noise_flag as boolean) ? 1 : 0,
          irt_theta_at_time: null,
          irt_se_at_time: null,
          irt_information: null,
          selection_reason: null,
          executed_at: new Date().toISOString(),
        });
      }

      for (const est of results.irt_estimates) {
        this.deps.db.irtEstimates.upsert({
          evaluation_id: evaluationId,
          dimension: est.dimension,
          theta: est.theta,
          se: est.se,
          ci_lower: est.ci_lower,
          ci_upper: est.ci_upper,
          n_tests: est.n_tests,
          n_tests_exhaustive: null,
          convergence_test_number: null,
          normalized_score: est.normalized_score,
        });
      }

      // 7. Analyze
      const report = await this.analyze(results);
      const duration_ms = Date.now() - startTime;
      report.summary.duration_ms = duration_ms;

      // 8. Update evaluation status
      this.deps.db.evaluations.updateStatus(
        evaluationId,
        "completed",
        new Date().toISOString(),
        duration_ms,
      );

      // 9. Disconnect
      await this.deps.adapter.disconnect();

      this.bus.emit("pipeline.completed", { report, duration_ms });
      return report;
    } catch (err) {
      this.bus.emit("pipeline.failed", {
        error: {
          module: "pipeline",
          severity: "fatal",
          code: "PIPELINE_FAIL",
          message: err instanceof Error ? err.message : String(err),
          recoverable: false,
        },
      });
      throw err;
    }
  }

  async introspect(target: TargetConfig): Promise<SystemProfile> {
    return this.deps.introspector.profile(target);
  }

  async map(profile: SystemProfile, compliance: ComplianceConfig): Promise<ComplianceReport> {
    const tests = this.deps.library.getAll();
    return this.deps.mapper.map(profile, compliance, tests);
  }

  async generate(profile: SystemProfile, compliance?: ComplianceReport): Promise<TestPlan> {
    return this.deps.generator.generate(profile, compliance, this.config?.execution);
  }

  async execute(
    plan: TestPlan,
    adapter: SystemAdapter,
    evaluationId?: string,
  ): Promise<ExecutionResults> {
    return this.deps.executor.execute(plan, adapter, evaluationId ?? crypto.randomUUID());
  }

  async analyze(results: ExecutionResults): Promise<AnalysisReport> {
    return this.deps.analyzer.analyze(results);
  }

  on(event: string, handler: (data: unknown) => void): void {
    // biome-ignore lint/suspicious/noExplicitAny: Pipeline interface bridges typed EventBus with generic string events
    this.bus.on(event as keyof APTEventMap, handler as any);
  }

  off(event: string, handler: (data: unknown) => void): void {
    // biome-ignore lint/suspicious/noExplicitAny: Pipeline interface bridges typed EventBus with generic string events
    this.bus.off(event as keyof APTEventMap, handler as any);
  }
}
