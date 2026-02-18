import { EventBus } from "@apt/core/event-bus";
import { closeDatabase, getDatabase } from "@apt/lib/db";
import { runMigrations } from "@apt/lib/migrations";
import { EvaluationRepository } from "@apt/lib/repositories/evaluations";
import { IRTEstimateRepository } from "@apt/lib/repositories/irt-estimates";
import { TestResultRepository } from "@apt/lib/repositories/test-results";
import type { ExecutionResults, IRTEstimate, TestDimension, TestResult } from "@apt/lib/types";
import { EXIT_CODES } from "@apt/lib/types";
import { Analyzer } from "@apt/modules/analyzer/index";
import { HtmlReporter } from "@apt/modules/analyzer/reports/html-reporter";
import { JsonReporter } from "@apt/modules/analyzer/reports/json-reporter";
import { defineCommand } from "citty";
import { consola } from "consola";

export default defineCommand({
  meta: { name: "report", version: "0.0.1", description: "Generate evaluation reports" },
  args: {
    evaluation: { type: "string", required: true, description: "Evaluation ID" },
    format: {
      type: "string",
      default: "json",
      description: "Report format: json | html | json,html",
    },
    output: { type: "string", default: "./apt-reports", description: "Output directory" },
  },
  async run({ args }) {
    try {
      const db = getDatabase();
      runMigrations(db);

      const evaluations = new EvaluationRepository(db);
      const testResults = new TestResultRepository(db);
      const irtEstimates = new IRTEstimateRepository(db);

      const evaluation = evaluations.findById(args.evaluation);
      if (!evaluation) {
        consola.error(`Evaluation ${args.evaluation} not found`);
        closeDatabase();
        process.exit(EXIT_CODES.ERROR);
      }

      // Reconstruct ExecutionResults from database
      const rawResults = testResults.findByEvaluation(evaluation.id);
      const rawEstimates = irtEstimates.findByEvaluation(evaluation.id);

      const reconstructedResults: ExecutionResults = {
        evaluation_id: evaluation.id,
        system_profile: evaluation.system_profile
          ? JSON.parse(evaluation.system_profile)
          : {
              id: "reconstructed",
              detected_at: evaluation.started_at,
              system_type: evaluation.system_type as "chatbot",
              detection_confidence: 0,
              detection_methods: [],
              input_interfaces: [],
              output_interfaces: [],
              capabilities: [],
              dependencies: [],
              adapter: {
                url: evaluation.target_url,
                adapter: "http" as const,
                timeout_ms: 30000,
                system_type: "auto" as const,
              },
            },
        test_results: rawResults.map(
          (r): TestResult => ({
            test_id: r.test_id,
            backend_id: r.backend_id ?? "built-in",
            passed: r.passed === 1,
            score: r.score,
            metrics: JSON.parse(r.metrics ?? "{}"),
            raw_output: r.raw_output ?? "",
            duration_ms: r.duration_ms,
            metadata: {},
          }),
        ),
        irt_estimates: rawEstimates.map(
          (e): IRTEstimate => ({
            dimension: e.dimension as TestDimension,
            theta: e.theta,
            se: e.se,
            ci_lower: e.ci_lower,
            ci_upper: e.ci_upper,
            n_tests: e.n_tests,
            normalized_score: e.normalized_score ?? 0,
          }),
        ),
        execution_metadata: {},
      };

      const bus = new EventBus();
      const analyzer = new Analyzer(bus);
      const report = await analyzer.analyze(reconstructedResults);

      const formats = args.format.split(",").map((f) => f.trim());
      for (const fmt of formats) {
        if (fmt === "json") {
          const path = await new JsonReporter().generate(report, args.output);
          consola.success(`JSON report: ${path}`);
        } else if (fmt === "html") {
          const path = await new HtmlReporter().generate(report, args.output);
          consola.success(`HTML report: ${path}`);
        }
      }

      closeDatabase();
    } catch (err) {
      consola.error("Report generation failed:", err instanceof Error ? err.message : String(err));
      closeDatabase();
      process.exit(EXIT_CODES.ERROR);
    }
  },
});
