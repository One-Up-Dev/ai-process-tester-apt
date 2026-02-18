// === APT Analyzer Module ===
// Transforms ExecutionResults into an AnalysisReport with scores, grades, and recommendations.

import type { EventBus } from "@apt/core/event-bus";
import type {
  AnalysisReport,
  ExecutionMetadataSummary,
  ExecutionResults,
  SystemProfile,
  SystemProfileSummary,
  TestDetail,
  TestDimension,
} from "@apt/lib/types";
import { overallScore, scoreToGrade } from "./statistics";

export class Analyzer {
  constructor(private bus: EventBus) {}

  async analyze(results: ExecutionResults): Promise<AnalysisReport> {
    this.bus.emit("analyzer.started", {});

    // 1. Build dimension details from IRT estimates
    const dimensions = results.irt_estimates.map((est) => ({
      dimension: est.dimension,
      theta: est.theta,
      se: est.se,
      normalized_score: est.normalized_score,
      grade: scoreToGrade(est.normalized_score),
      n_tests: est.n_tests,
      ci_lower: est.ci_lower,
      ci_upper: est.ci_upper,
    }));

    // 2. Overall score = average of normalized scores
    const overall = overallScore(dimensions.map((d) => d.normalized_score));
    const overallGrade = scoreToGrade(overall);

    // 3. Generate recommendations
    const recommendations = this.generateRecommendations(dimensions);

    const report: AnalysisReport = {
      evaluation_id: results.evaluation_id,
      summary: {
        overall_score: overall,
        overall_grade: overallGrade,
        dimensions_tested: dimensions.length,
        total_tests: results.test_results.length,
        duration_ms: 0, // filled by pipeline
      },
      dimensions,
      compliance: null,
      drift: null,
      comparisons: [],
      recommendations,
      trace: {
        pipeline_version: "0.1.0",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        modules: ["introspector", "generator", "executor", "analyzer"],
      },
    };

    // Enrich with per-test details when planned_tests are available
    if (results.planned_tests) {
      report.test_details = this.buildTestDetails(results);
    }
    report.system_profile = this.buildSystemProfileSummary(results.system_profile);
    report.execution_metadata_summary = this.buildExecutionMetadataSummary(results);

    this.bus.emit("analyzer.completed", { report });
    return report;
  }

  private generateRecommendations(
    dimensions: Array<{
      dimension: TestDimension;
      normalized_score: number;
      grade: string;
    }>,
  ): AnalysisReport["recommendations"] {
    const recs: AnalysisReport["recommendations"] = [];

    for (const dim of dimensions) {
      if (dim.normalized_score < 55) {
        // Grade D or F -> high priority
        recs.push({
          dimension: dim.dimension,
          priority: "high",
          description: `${dim.dimension} score is critically low (${dim.normalized_score.toFixed(1)}%, grade ${dim.grade}). Immediate improvements needed.`,
        });
      } else if (dim.normalized_score < 70) {
        // Grade C -> high priority
        recs.push({
          dimension: dim.dimension,
          priority: "high",
          description: `${dim.dimension} score is below acceptable threshold (${dim.normalized_score.toFixed(1)}%, grade ${dim.grade}). Significant improvements recommended.`,
        });
      } else if (dim.normalized_score < 85) {
        // Grade B -> medium priority
        recs.push({
          dimension: dim.dimension,
          priority: "medium",
          description: `${dim.dimension} score is good but can be improved (${dim.normalized_score.toFixed(1)}%, grade ${dim.grade}).`,
        });
      }
      // Grade A -> no recommendation needed
    }

    return recs.sort((a, b) => {
      const prio = { high: 0, medium: 1, low: 2 };
      return prio[a.priority] - prio[b.priority];
    });
  }

  private buildTestDetails(results: ExecutionResults): TestDetail[] {
    const planMap = new Map((results.planned_tests ?? []).map((t) => [t.id, t]));

    return results.test_results.map((tr) => {
      const plan = planMap.get(tr.test_id);
      return {
        test_id: tr.test_id,
        name: plan?.name ?? tr.test_id,
        description: (plan?.metadata?.description as string) ?? "",
        dimension: plan?.dimension ?? "functional",
        category: plan?.category ?? "functional",
        tags: (plan?.metadata?.tags as string[]) ?? [],
        input_content: plan?.input?.content ?? "",
        expected_behavior: plan?.expected_behavior ?? "",
        raw_output: tr.raw_output ?? "",
        passed: tr.passed,
        score: tr.score,
        duration_ms: tr.duration_ms,
        evaluator_results:
          (tr.metadata?.evaluator_results as TestDetail["evaluator_results"]) ?? [],
        noise_cv: tr.metadata?.noise_cv as number | undefined,
        noise_flag: tr.metadata?.noise_flag as boolean | undefined,
        replications: tr.replications,
        irt_params: plan?.irt_params,
        irt_theta_at_time: tr.metadata?.irt_theta_at_time as number | undefined,
        irt_se_at_time: tr.metadata?.irt_se_at_time as number | undefined,
        selection_reason: tr.metadata?.selection_reason as string | undefined,
        compliance: plan?.metadata?.compliance as TestDetail["compliance"],
      };
    });
  }

  private buildSystemProfileSummary(profile: SystemProfile): SystemProfileSummary {
    return {
      system_type: profile.system_type,
      detection_confidence: profile.detection_confidence,
      detection_methods: profile.detection_methods.map((m) => ({
        method: m.method,
        confidence: m.confidence,
      })),
      capabilities: profile.capabilities,
      baseline_metrics: profile.baseline_metrics,
    };
  }

  private buildExecutionMetadataSummary(results: ExecutionResults): ExecutionMetadataSummary {
    const backends = [...new Set(results.test_results.map((tr) => tr.backend_id))];
    return {
      strategy: (results.execution_metadata.strategy as string) ?? "unknown",
      backends_used: backends,
      total_duration_ms: results.test_results.reduce((sum, tr) => sum + tr.duration_ms, 0),
    };
  }
}
