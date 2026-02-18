import type { Database } from "bun:sqlite";

export interface EvaluationRow {
  id: string;
  target_url: string;
  system_type: string;
  system_profile: string | null;
  compliance_report: string | null;
  config: string | null;
  mode: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  created_at: string;
}

export class EvaluationRepository {
  constructor(private db: Database) {}

  create(eval_: Omit<EvaluationRow, "created_at">): void {
    this.db
      .prepare(
        `INSERT INTO evaluations (id, target_url, system_type, system_profile, compliance_report, config, mode, status, started_at, completed_at, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eval_.id,
        eval_.target_url,
        eval_.system_type,
        eval_.system_profile,
        eval_.compliance_report,
        eval_.config,
        eval_.mode,
        eval_.status,
        eval_.started_at,
        eval_.completed_at,
        eval_.duration_ms,
      );
  }

  findById(id: string): EvaluationRow | null {
    return this.db
      .prepare("SELECT * FROM evaluations WHERE id = ?")
      .get(id) as EvaluationRow | null;
  }

  updateStatus(id: string, status: string, completedAt?: string, durationMs?: number): void {
    this.db
      .prepare("UPDATE evaluations SET status = ?, completed_at = ?, duration_ms = ? WHERE id = ?")
      .run(status, completedAt ?? null, durationMs ?? null, id);
  }

  findByTarget(targetUrl: string): EvaluationRow[] {
    return this.db
      .prepare("SELECT * FROM evaluations WHERE target_url = ? ORDER BY created_at DESC")
      .all(targetUrl) as EvaluationRow[];
  }

  findRecent(limit = 10): EvaluationRow[] {
    return this.db
      .prepare("SELECT * FROM evaluations ORDER BY created_at DESC LIMIT ?")
      .all(limit) as EvaluationRow[];
  }
}
