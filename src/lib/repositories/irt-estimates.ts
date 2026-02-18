import type { Database } from "bun:sqlite";

export interface IRTEstimateRow {
  evaluation_id: string;
  dimension: string;
  theta: number;
  se: number;
  ci_lower: number;
  ci_upper: number;
  n_tests: number;
  n_tests_exhaustive: number | null;
  convergence_test_number: number | null;
  normalized_score: number | null;
}

export class IRTEstimateRepository {
  constructor(private db: Database) {}

  upsert(row: IRTEstimateRow): void {
    this.db
      .prepare(
        `INSERT INTO irt_estimates (evaluation_id, dimension, theta, se, ci_lower, ci_upper, n_tests, n_tests_exhaustive, convergence_test_number, normalized_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(evaluation_id, dimension) DO UPDATE SET
         theta = excluded.theta, se = excluded.se, ci_lower = excluded.ci_lower,
         ci_upper = excluded.ci_upper, n_tests = excluded.n_tests,
         n_tests_exhaustive = excluded.n_tests_exhaustive,
         convergence_test_number = excluded.convergence_test_number,
         normalized_score = excluded.normalized_score`,
      )
      .run(
        row.evaluation_id,
        row.dimension,
        row.theta,
        row.se,
        row.ci_lower,
        row.ci_upper,
        row.n_tests,
        row.n_tests_exhaustive,
        row.convergence_test_number,
        row.normalized_score,
      );
  }

  findByEvaluation(evaluationId: string): IRTEstimateRow[] {
    return this.db
      .prepare("SELECT * FROM irt_estimates WHERE evaluation_id = ?")
      .all(evaluationId) as IRTEstimateRow[];
  }

  findByDimension(evaluationId: string, dimension: string): IRTEstimateRow | null {
    return this.db
      .prepare("SELECT * FROM irt_estimates WHERE evaluation_id = ? AND dimension = ?")
      .get(evaluationId, dimension) as IRTEstimateRow | null;
  }
}
