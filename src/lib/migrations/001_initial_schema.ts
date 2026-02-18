import type { Database } from "bun:sqlite";

export const version = 1;
export const name = "initial_schema";

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evaluations (
      id TEXT PRIMARY KEY,
      target_url TEXT NOT NULL,
      system_type TEXT NOT NULL,
      system_profile TEXT, -- JSON
      compliance_report TEXT, -- JSON
      config TEXT, -- JSON
      mode TEXT NOT NULL DEFAULT 'adaptive',
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL,
      completed_at TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS test_results (
      id TEXT PRIMARY KEY,
      evaluation_id TEXT NOT NULL,
      test_id TEXT NOT NULL,
      dimension TEXT NOT NULL,
      category TEXT NOT NULL,
      backend_id TEXT,
      passed INTEGER NOT NULL, -- 0 or 1
      score REAL NOT NULL,
      metrics TEXT, -- JSON
      raw_input TEXT,
      raw_output TEXT,
      duration_ms INTEGER NOT NULL,
      replications TEXT, -- JSON
      noise_cv REAL,
      noise_flag INTEGER DEFAULT 0,
      irt_theta_at_time REAL,
      irt_se_at_time REAL,
      irt_information REAL,
      selection_reason TEXT,
      executed_at TEXT NOT NULL,
      UNIQUE(evaluation_id, test_id),
      FOREIGN KEY (evaluation_id) REFERENCES evaluations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS irt_estimates (
      evaluation_id TEXT NOT NULL,
      dimension TEXT NOT NULL,
      theta REAL NOT NULL,
      se REAL NOT NULL,
      ci_lower REAL NOT NULL,
      ci_upper REAL NOT NULL,
      n_tests INTEGER NOT NULL,
      n_tests_exhaustive INTEGER,
      convergence_test_number INTEGER,
      normalized_score REAL,
      PRIMARY KEY (evaluation_id, dimension),
      FOREIGN KEY (evaluation_id) REFERENCES evaluations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS test_calibration (
      test_id TEXT PRIMARY KEY,
      difficulty REAL NOT NULL,
      discrimination REAL NOT NULL,
      guessing REAL NOT NULL DEFAULT 0.05,
      calibration_n INTEGER,
      calibration_date TEXT,
      is_preliminary INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS comparisons (
      id TEXT PRIMARY KEY,
      baseline_evaluation_id TEXT NOT NULL,
      candidate_evaluation_id TEXT NOT NULL,
      dimension TEXT NOT NULL,
      baseline_theta REAL NOT NULL,
      candidate_theta REAL NOT NULL,
      delta_theta REAL NOT NULL,
      cohens_d REAL,
      p_value REAL,
      statistical_power REAL,
      conclusion TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (baseline_evaluation_id) REFERENCES evaluations(id),
      FOREIGN KEY (candidate_evaluation_id) REFERENCES evaluations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_test_results_evaluation ON test_results(evaluation_id);
    CREATE INDEX IF NOT EXISTS idx_test_results_dimension ON test_results(dimension);
    CREATE INDEX IF NOT EXISTS idx_irt_estimates_evaluation ON irt_estimates(evaluation_id);
    CREATE INDEX IF NOT EXISTS idx_evaluations_target ON evaluations(target_url);
    CREATE INDEX IF NOT EXISTS idx_evaluations_status ON evaluations(status);
  `);
}
