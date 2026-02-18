import type { Database } from "bun:sqlite";

export interface ComparisonRow {
  id: string;
  baseline_evaluation_id: string;
  candidate_evaluation_id: string;
  dimension: string;
  baseline_theta: number;
  candidate_theta: number;
  delta_theta: number;
  cohens_d: number | null;
  p_value: number | null;
  statistical_power: number | null;
  conclusion: string | null;
  created_at: string;
}

export class ComparisonRepository {
  constructor(private db: Database) {}

  create(row: Omit<ComparisonRow, "created_at">): void {
    this.db
      .prepare(
        `INSERT INTO comparisons (id, baseline_evaluation_id, candidate_evaluation_id, dimension, baseline_theta, candidate_theta, delta_theta, cohens_d, p_value, statistical_power, conclusion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.baseline_evaluation_id,
        row.candidate_evaluation_id,
        row.dimension,
        row.baseline_theta,
        row.candidate_theta,
        row.delta_theta,
        row.cohens_d,
        row.p_value,
        row.statistical_power,
        row.conclusion,
      );
  }

  findByEvaluation(evaluationId: string): ComparisonRow[] {
    return this.db
      .prepare(
        "SELECT * FROM comparisons WHERE baseline_evaluation_id = ? OR candidate_evaluation_id = ? ORDER BY created_at DESC",
      )
      .all(evaluationId, evaluationId) as ComparisonRow[];
  }

  findByBaseline(baselineId: string): ComparisonRow[] {
    return this.db
      .prepare(
        "SELECT * FROM comparisons WHERE baseline_evaluation_id = ? ORDER BY created_at DESC",
      )
      .all(baselineId) as ComparisonRow[];
  }
}
