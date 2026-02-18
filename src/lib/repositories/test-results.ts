import type { Database } from "bun:sqlite";

export interface TestResultRow {
  id: string;
  evaluation_id: string;
  test_id: string;
  dimension: string;
  category: string;
  backend_id: string | null;
  passed: number;
  score: number;
  metrics: string | null;
  raw_input: string | null;
  raw_output: string | null;
  duration_ms: number;
  replications: string | null;
  noise_cv: number | null;
  noise_flag: number;
  irt_theta_at_time: number | null;
  irt_se_at_time: number | null;
  irt_information: number | null;
  selection_reason: string | null;
  executed_at: string;
}

export class TestResultRepository {
  constructor(private db: Database) {}

  create(row: TestResultRow): void {
    this.db
      .prepare(
        `INSERT INTO test_results (id, evaluation_id, test_id, dimension, category, backend_id, passed, score, metrics, raw_input, raw_output, duration_ms, replications, noise_cv, noise_flag, irt_theta_at_time, irt_se_at_time, irt_information, selection_reason, executed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.evaluation_id,
        row.test_id,
        row.dimension,
        row.category,
        row.backend_id,
        row.passed,
        row.score,
        row.metrics,
        row.raw_input,
        row.raw_output,
        row.duration_ms,
        row.replications,
        row.noise_cv,
        row.noise_flag,
        row.irt_theta_at_time,
        row.irt_se_at_time,
        row.irt_information,
        row.selection_reason,
        row.executed_at,
      );
  }

  createBatch(rows: TestResultRow[]): void {
    const insert = this.db.prepare(
      `INSERT INTO test_results (id, evaluation_id, test_id, dimension, category, backend_id, passed, score, metrics, raw_input, raw_output, duration_ms, replications, noise_cv, noise_flag, irt_theta_at_time, irt_se_at_time, irt_information, selection_reason, executed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const transaction = this.db.transaction((rows: TestResultRow[]) => {
      for (const row of rows) {
        insert.run(
          row.id,
          row.evaluation_id,
          row.test_id,
          row.dimension,
          row.category,
          row.backend_id,
          row.passed,
          row.score,
          row.metrics,
          row.raw_input,
          row.raw_output,
          row.duration_ms,
          row.replications,
          row.noise_cv,
          row.noise_flag,
          row.irt_theta_at_time,
          row.irt_se_at_time,
          row.irt_information,
          row.selection_reason,
          row.executed_at,
        );
      }
    });
    transaction(rows);
  }

  findByEvaluation(evaluationId: string): TestResultRow[] {
    return this.db
      .prepare("SELECT * FROM test_results WHERE evaluation_id = ? ORDER BY executed_at")
      .all(evaluationId) as TestResultRow[];
  }

  findByDimension(evaluationId: string, dimension: string): TestResultRow[] {
    return this.db
      .prepare("SELECT * FROM test_results WHERE evaluation_id = ? AND dimension = ?")
      .all(evaluationId, dimension) as TestResultRow[];
  }

  countByEvaluation(evaluationId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM test_results WHERE evaluation_id = ?")
      .get(evaluationId) as { count: number };
    return row.count;
  }
}
