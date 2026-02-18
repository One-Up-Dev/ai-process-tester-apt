import { EventBus } from "@apt/core/event-bus";
import { type PipelineDeps, PipelineOrchestrator } from "@apt/core/pipeline";
import { loadConfig } from "@apt/lib/config";
import { closeDatabase, getDatabase } from "@apt/lib/db";
import { runMigrations } from "@apt/lib/migrations";
import { EvaluationRepository } from "@apt/lib/repositories/evaluations";
import { IRTEstimateRepository } from "@apt/lib/repositories/irt-estimates";
import { TestResultRepository } from "@apt/lib/repositories/test-results";
import { type AptConfig, AptConfigSchema } from "@apt/lib/schema";
import { EXIT_CODES } from "@apt/lib/types";
import { Analyzer } from "@apt/modules/analyzer/index";
import { HtmlReporter } from "@apt/modules/analyzer/reports/html-reporter";
import { JsonReporter } from "@apt/modules/analyzer/reports/json-reporter";
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
import { defineCommand } from "citty";
import { consola } from "consola";

// Guided mode messages
const GUIDED = {
  introspect_before: `
STEP 1: System Introspection
APT is analyzing your AI system to understand its type, capabilities, and behavior patterns.
This helps select the most relevant tests for your specific system.`,
  introspect_after: (type: string, confidence: number) =>
    `System detected: ${type} (confidence: ${(confidence * 100).toFixed(0)}%)`,
  generate_before: `
STEP 2: Test Plan Generation
APT is selecting tests from its calibrated library matching your system type.
Each test has IRT parameters for adaptive evaluation.`,
  generate_after: (count: number, estimated: number) =>
    `${count} tests selected, ~${estimated} estimated with adaptive mode`,
  execute_before: `
STEP 3: Test Execution
Running tests with adaptive selection (IRT-based). Tests are selected to maximize
information about your system's capabilities.`,
  execute_after: (total: number) => `${total} tests executed`,
  analyze_before: `
STEP 4: Analysis
Computing scores, grades, and generating recommendations.`,
  analyze_after: (score: number, grade: string) =>
    `Overall score: ${score.toFixed(1)}/100 (${grade})`,
};

export default defineCommand({
  meta: {
    name: "run",
    version: "0.0.1",
    description: "Run an APT evaluation pipeline",
  },
  args: {
    target: { type: "string", description: "Target URL (overrides config)" },
    model: { type: "string", description: "Model name (overrides config)" },
    mode: {
      type: "string",
      description: "Evaluation mode: adaptive | exhaustive",
      default: "adaptive",
    },
    report: {
      type: "string",
      description: "Report formats (comma-separated: json,html)",
      default: "json,html",
    },
    output: {
      type: "string",
      description: "Output directory for reports",
      default: "./apt-reports",
    },
    guided: { type: "boolean", description: "Guided mode with explanations", default: false },
    replications: {
      type: "string",
      description: "Number of replications per test (default: 3, use 1 to save API costs)",
    },
    "auth-token": { type: "string", description: "Auth token (Bearer) for the target API" },
    config: { type: "string", description: "Config file path" },
  },
  async run({ args }) {
    try {
      // 1. Load config (file or args)
      let config: AptConfig;
      const configPath = args.config ?? "apt.config.yaml";
      try {
        config = await loadConfig(configPath);
      } catch {
        if (!args.target) {
          consola.error(
            "No config file found and no --target specified. Run `apt init` first or provide --target.",
          );
          process.exit(EXIT_CODES.ERROR);
        }
        // Build config from args
        config = AptConfigSchema.parse({
          version: "1",
          target: { url: args.target, adapter: "http" },
          execution: { mode: args.mode },
          reports: { formats: args.report.split(","), output_dir: args.output },
        });
      }

      // Override target if specified
      if (args.target) {
        config.target.url = args.target;
      }

      // Override model if specified
      if (args.model) {
        config.target.model = args.model;
      }

      // Override mode
      if (args.mode) {
        config.execution.mode = args.mode as "adaptive" | "exhaustive";
      }

      // Override replications
      if (args.replications) {
        config.execution.replications = Number.parseInt(args.replications, 10);
      }

      // Override auth token (arg > env var)
      const authToken = args["auth-token"] || Bun.env.OPENROUTER_API_KEY;
      if (authToken) {
        config.target.auth = { type: "bearer", token: authToken };
      }

      // 2. Setup database
      const db = getDatabase(config.storage?.database ?? "apt.db");
      runMigrations(db);

      // 3. Build pipeline (DI)
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

      const deps: PipelineDeps = {
        bus,
        introspector: new Introspector(detectors, adapter, bus),
        mapper: new ComplianceMapper(bus),
        generator: new TestGenerator(library, bus),
        executor: new AdaptiveExecutor([new BuiltInBackend()], bus, config.execution),
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

      // Setup console logging for events
      bus.on("executor.test.completed", (data) => {
        consola.info(
          `[${data.dimension}] ${data.test_id}: ${data.passed ? "PASS" : "FAIL"} | \u03B8=${data.theta.toFixed(2)} | SE=${data.se.toFixed(2)}`,
        );
      });

      bus.on("executor.dimension.converged", (data) => {
        consola.success(
          `[${data.dimension}] Converged! \u03B8=${data.theta.toFixed(2)} SE=${data.se.toFixed(2)} (${data.reason})`,
        );
      });

      bus.on("pipeline.failed", (data) => {
        consola.error(`[${data.error.module}] ${data.error.message}`);
      });

      // Guided mode: hook intermediate messages to EventBus
      if (args.guided) {
        bus.on("introspector.completed", (data) => {
          consola.info(
            GUIDED.introspect_after(data.profile.system_type, data.profile.detection_confidence),
          );
          consola.info(GUIDED.generate_before);
        });
        bus.on("executor.started", (data) => {
          consola.info(
            GUIDED.generate_after(data.plan.tests.length, data.plan.estimates.estimated_tests),
          );
          consola.info(GUIDED.execute_before);
        });
        bus.on("executor.completed", (data) => {
          consola.info(GUIDED.execute_after(data.results.test_results.length));
          consola.info(GUIDED.analyze_before);
        });
      }

      // 4. Run pipeline
      const pipelineConfig = {
        target: config.target,
        compliance: config.compliance,
        execution: config.execution,
        analysis: config.analysis,
        reports: config.reports ?? {
          formats: ["json", "html"],
          output_dir: args.output,
          include_raw_data: false,
        },
      };

      if (args.guided) consola.info(GUIDED.introspect_before);

      const report = await pipeline.run(pipelineConfig);

      if (args.guided) {
        consola.info(
          GUIDED.analyze_after(report.summary.overall_score, report.summary.overall_grade),
        );
      }

      // 5. Generate reports
      const outputDir = args.output ?? config.reports?.output_dir ?? "./apt-reports";
      const formats = (args.report ?? "json,html").split(",").map((f) => f.trim());

      const reportPaths: string[] = [];
      if (formats.includes("json")) {
        const path = await new JsonReporter().generate(report, outputDir);
        reportPaths.push(path);
        bus.emit("analyzer.report.generated", { format: "json", path });
      }
      if (formats.includes("html")) {
        const path = await new HtmlReporter().generate(report, outputDir);
        reportPaths.push(path);
        bus.emit("analyzer.report.generated", { format: "html", path });
      }

      // 6. Summary
      consola.log("");
      consola.success("EVALUATION COMPLETE");
      consola.log(
        `  Score: ${report.summary.overall_score.toFixed(1)}/100 (${report.summary.overall_grade})`,
      );
      consola.log(`  Dimensions: ${report.summary.dimensions_tested}`);
      consola.log(`  Tests: ${report.summary.total_tests}`);
      consola.log(`  Time: ${(report.summary.duration_ms / 1000).toFixed(1)}s`);
      for (const p of reportPaths) {
        consola.log(`  Report: ${p}`);
      }

      // 7. Cleanup and exit
      closeDatabase();
      process.exit(report.summary.overall_score >= 75 ? EXIT_CODES.PASS : EXIT_CODES.FAIL);
    } catch (err) {
      consola.error("Pipeline failed:", err instanceof Error ? err.message : String(err));
      closeDatabase();
      process.exit(EXIT_CODES.ERROR);
    }
  },
});
