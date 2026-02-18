import type { Database } from "bun:sqlite";

export interface TestCalibrationRow {
  test_id: string;
  difficulty: number;
  discrimination: number;
  guessing: number;
  calibration_n: number | null;
  calibration_date: string | null;
  is_preliminary: number;
  updated_at: string;
}

export class TestCalibrationRepository {
  constructor(private db: Database) {}

  upsert(row: TestCalibrationRow): void {
    this.db
      .prepare(
        `INSERT INTO test_calibration (test_id, difficulty, discrimination, guessing, calibration_n, calibration_date, is_preliminary, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(test_id) DO UPDATE SET
         difficulty = excluded.difficulty, discrimination = excluded.discrimination,
         guessing = excluded.guessing, calibration_n = excluded.calibration_n,
         calibration_date = excluded.calibration_date, is_preliminary = excluded.is_preliminary,
         updated_at = excluded.updated_at`,
      )
      .run(
        row.test_id,
        row.difficulty,
        row.discrimination,
        row.guessing,
        row.calibration_n,
        row.calibration_date,
        row.is_preliminary,
        row.updated_at,
      );
  }

  findById(testId: string): TestCalibrationRow | null {
    return this.db
      .prepare("SELECT * FROM test_calibration WHERE test_id = ?")
      .get(testId) as TestCalibrationRow | null;
  }

  findAll(): TestCalibrationRow[] {
    return this.db
      .prepare("SELECT * FROM test_calibration ORDER BY test_id")
      .all() as TestCalibrationRow[];
  }

  findPreliminary(): TestCalibrationRow[] {
    return this.db
      .prepare("SELECT * FROM test_calibration WHERE is_preliminary = 1")
      .all() as TestCalibrationRow[];
  }
}
