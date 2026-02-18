import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDatabase } from "@apt/lib/db";
import { runMigrations } from "@apt/lib/migrations";
import { ComparisonRepository } from "@apt/lib/repositories/comparisons";
import { EvaluationRepository } from "@apt/lib/repositories/evaluations";
import { IRTEstimateRepository } from "@apt/lib/repositories/irt-estimates";
import { TestCalibrationRepository } from "@apt/lib/repositories/test-calibration";
import { TestResultRepository } from "@apt/lib/repositories/test-results";

// Helper to create a fresh migrated in-memory DB for each test
function setupDb(): Database {
  const db = createTestDatabase();
  runMigrations(db);
  return db;
}

// Helper to create a minimal evaluation row
function makeEvaluation(overrides: Record<string, unknown> = {}) {
  return {
    id: "eval-001",
    target_url: "https://api.example.com/chat",
    system_type: "chatbot",
    system_profile: null,
    compliance_report: null,
    config: null,
    mode: "adaptive",
    status: "running",
    started_at: "2026-01-15T10:00:00Z",
    completed_at: null,
    duration_ms: null,
    ...overrides,
  };
}

// Helper to create a minimal test result row
function makeTestResult(overrides: Record<string, unknown> = {}) {
  return {
    id: "tr-001",
    evaluation_id: "eval-001",
    test_id: "test-robustness-001",
    dimension: "robustness",
    category: "robustness",
    backend_id: "local-prompt",
    passed: 1,
    score: 0.85,
    metrics: null,
    raw_input: null,
    raw_output: null,
    duration_ms: 150,
    replications: null,
    noise_cv: null,
    noise_flag: 0,
    irt_theta_at_time: null,
    irt_se_at_time: null,
    irt_information: null,
    selection_reason: null,
    executed_at: "2026-01-15T10:01:00Z",
    ...overrides,
  };
}

// =====================================================
// TABLE CREATION TESTS
// =====================================================
describe("Table creation", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
  });

  test("evaluations table exists", () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='evaluations'")
      .get() as { name: string } | null;
    expect(row).not.toBeNull();
    expect(row?.name).toBe("evaluations");
  });

  test("test_results table exists", () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_results'")
      .get() as { name: string } | null;
    expect(row).not.toBeNull();
    expect(row?.name).toBe("test_results");
  });

  test("irt_estimates table exists", () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='irt_estimates'")
      .get() as { name: string } | null;
    expect(row).not.toBeNull();
    expect(row?.name).toBe("irt_estimates");
  });

  test("test_calibration table exists", () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_calibration'")
      .get() as { name: string } | null;
    expect(row).not.toBeNull();
    expect(row?.name).toBe("test_calibration");
  });

  test("comparisons table exists", () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='comparisons'")
      .get() as { name: string } | null;
    expect(row).not.toBeNull();
    expect(row?.name).toBe("comparisons");
  });
});

// =====================================================
// MIGRATION IDEMPOTENCY TESTS
// =====================================================
describe("Migration idempotency", () => {
  test("running migrations twice does not throw", () => {
    const db = createTestDatabase();
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });

  test("_migrations table records the correct version", () => {
    const db = createTestDatabase();
    runMigrations(db);
    const rows = db.prepare("SELECT version, name FROM _migrations").all() as Array<{
      version: number;
      name: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(1);
    expect(rows[0].name).toBe("initial_schema");
  });
});

// =====================================================
// EVALUATIONS CRUD TESTS
// =====================================================
describe("EvaluationRepository", () => {
  let db: Database;
  let repo: EvaluationRepository;

  beforeEach(() => {
    db = setupDb();
    repo = new EvaluationRepository(db);
  });

  test("create and findById", () => {
    const eval_ = makeEvaluation();
    repo.create(eval_);
    const found = repo.findById("eval-001");
    expect(found).not.toBeNull();
    expect(found?.id).toBe("eval-001");
    expect(found?.target_url).toBe("https://api.example.com/chat");
    expect(found?.system_type).toBe("chatbot");
    expect(found?.status).toBe("running");
  });

  test("findById returns null for non-existent id", () => {
    const found = repo.findById("non-existent");
    expect(found).toBeNull();
  });

  test("updateStatus updates correctly", () => {
    repo.create(makeEvaluation());
    repo.updateStatus("eval-001", "completed", "2026-01-15T10:30:00Z", 1800000);
    const found = repo.findById("eval-001");
    expect(found?.status).toBe("completed");
    expect(found?.completed_at).toBe("2026-01-15T10:30:00Z");
    expect(found?.duration_ms).toBe(1800000);
  });

  test("findByTarget returns evaluations for a target URL", () => {
    repo.create(makeEvaluation({ id: "eval-001" }));
    repo.create(
      makeEvaluation({
        id: "eval-002",
        target_url: "https://api.example.com/chat",
      }),
    );
    repo.create(
      makeEvaluation({
        id: "eval-003",
        target_url: "https://other.example.com/api",
      }),
    );

    const results = repo.findByTarget("https://api.example.com/chat");
    expect(results).toHaveLength(2);
  });

  test("findRecent respects limit", () => {
    for (let i = 0; i < 5; i++) {
      repo.create(makeEvaluation({ id: `eval-${i}` }));
    }
    const results = repo.findRecent(3);
    expect(results).toHaveLength(3);
  });
});

// =====================================================
// TEST RESULTS CRUD TESTS
// =====================================================
describe("TestResultRepository", () => {
  let db: Database;
  let evalRepo: EvaluationRepository;
  let repo: TestResultRepository;

  beforeEach(() => {
    db = setupDb();
    evalRepo = new EvaluationRepository(db);
    repo = new TestResultRepository(db);
    // Create parent evaluation for FK
    evalRepo.create(makeEvaluation());
  });

  test("create and findByEvaluation", () => {
    repo.create(makeTestResult());
    const results = repo.findByEvaluation("eval-001");
    expect(results).toHaveLength(1);
    expect(results[0].test_id).toBe("test-robustness-001");
    expect(results[0].score).toBe(0.85);
  });

  test("createBatch inserts multiple rows", () => {
    const rows = [
      makeTestResult({ id: "tr-001", test_id: "test-001" }),
      makeTestResult({ id: "tr-002", test_id: "test-002" }),
      makeTestResult({ id: "tr-003", test_id: "test-003" }),
    ];
    repo.createBatch(rows);
    const results = repo.findByEvaluation("eval-001");
    expect(results).toHaveLength(3);
  });

  test("findByDimension filters correctly", () => {
    repo.create(makeTestResult({ id: "tr-001", test_id: "test-001", dimension: "robustness" }));
    repo.create(makeTestResult({ id: "tr-002", test_id: "test-002", dimension: "fairness" }));
    repo.create(makeTestResult({ id: "tr-003", test_id: "test-003", dimension: "robustness" }));

    const robustness = repo.findByDimension("eval-001", "robustness");
    expect(robustness).toHaveLength(2);

    const fairness = repo.findByDimension("eval-001", "fairness");
    expect(fairness).toHaveLength(1);
  });

  test("countByEvaluation returns correct count", () => {
    repo.create(makeTestResult({ id: "tr-001", test_id: "test-001" }));
    repo.create(makeTestResult({ id: "tr-002", test_id: "test-002" }));
    expect(repo.countByEvaluation("eval-001")).toBe(2);
    expect(repo.countByEvaluation("non-existent")).toBe(0);
  });
});

// =====================================================
// IRT ESTIMATES CRUD TESTS
// =====================================================
describe("IRTEstimateRepository", () => {
  let db: Database;
  let evalRepo: EvaluationRepository;
  let repo: IRTEstimateRepository;

  beforeEach(() => {
    db = setupDb();
    evalRepo = new EvaluationRepository(db);
    repo = new IRTEstimateRepository(db);
    evalRepo.create(makeEvaluation());
  });

  test("upsert inserts a new estimate", () => {
    repo.upsert({
      evaluation_id: "eval-001",
      dimension: "robustness",
      theta: 1.5,
      se: 0.3,
      ci_lower: 0.9,
      ci_upper: 2.1,
      n_tests: 20,
      n_tests_exhaustive: null,
      convergence_test_number: 15,
      normalized_score: 0.78,
    });

    const found = repo.findByDimension("eval-001", "robustness");
    expect(found).not.toBeNull();
    expect(found?.theta).toBe(1.5);
    expect(found?.se).toBe(0.3);
    expect(found?.n_tests).toBe(20);
  });

  test("upsert updates an existing estimate", () => {
    repo.upsert({
      evaluation_id: "eval-001",
      dimension: "robustness",
      theta: 1.5,
      se: 0.3,
      ci_lower: 0.9,
      ci_upper: 2.1,
      n_tests: 20,
      n_tests_exhaustive: null,
      convergence_test_number: 15,
      normalized_score: 0.78,
    });

    // Update with new values
    repo.upsert({
      evaluation_id: "eval-001",
      dimension: "robustness",
      theta: 2.0,
      se: 0.2,
      ci_lower: 1.6,
      ci_upper: 2.4,
      n_tests: 30,
      n_tests_exhaustive: null,
      convergence_test_number: 18,
      normalized_score: 0.88,
    });

    const found = repo.findByDimension("eval-001", "robustness");
    expect(found?.theta).toBe(2.0);
    expect(found?.se).toBe(0.2);
    expect(found?.n_tests).toBe(30);
    expect(found?.normalized_score).toBe(0.88);
  });

  test("findByEvaluation returns all dimensions", () => {
    repo.upsert({
      evaluation_id: "eval-001",
      dimension: "robustness",
      theta: 1.5,
      se: 0.3,
      ci_lower: 0.9,
      ci_upper: 2.1,
      n_tests: 20,
      n_tests_exhaustive: null,
      convergence_test_number: null,
      normalized_score: null,
    });
    repo.upsert({
      evaluation_id: "eval-001",
      dimension: "fairness",
      theta: 0.8,
      se: 0.4,
      ci_lower: 0.0,
      ci_upper: 1.6,
      n_tests: 15,
      n_tests_exhaustive: null,
      convergence_test_number: null,
      normalized_score: null,
    });

    const results = repo.findByEvaluation("eval-001");
    expect(results).toHaveLength(2);
  });
});

// =====================================================
// TEST CALIBRATION CRUD TESTS
// =====================================================
describe("TestCalibrationRepository", () => {
  let db: Database;
  let repo: TestCalibrationRepository;

  beforeEach(() => {
    db = setupDb();
    repo = new TestCalibrationRepository(db);
  });

  test("upsert and findById", () => {
    repo.upsert({
      test_id: "test-robustness-001",
      difficulty: 0.5,
      discrimination: 1.2,
      guessing: 0.05,
      calibration_n: 100,
      calibration_date: "2026-01-10",
      is_preliminary: 1,
      updated_at: "2026-01-10T12:00:00Z",
    });

    const found = repo.findById("test-robustness-001");
    expect(found).not.toBeNull();
    expect(found?.difficulty).toBe(0.5);
    expect(found?.discrimination).toBe(1.2);
    expect(found?.is_preliminary).toBe(1);
  });

  test("findAll returns all calibrations ordered by test_id", () => {
    repo.upsert({
      test_id: "test-b",
      difficulty: 0.5,
      discrimination: 1.0,
      guessing: 0.05,
      calibration_n: null,
      calibration_date: null,
      is_preliminary: 1,
      updated_at: "2026-01-10T12:00:00Z",
    });
    repo.upsert({
      test_id: "test-a",
      difficulty: 1.0,
      discrimination: 0.8,
      guessing: 0.1,
      calibration_n: null,
      calibration_date: null,
      is_preliminary: 0,
      updated_at: "2026-01-10T12:00:00Z",
    });

    const all = repo.findAll();
    expect(all).toHaveLength(2);
    expect(all[0].test_id).toBe("test-a");
    expect(all[1].test_id).toBe("test-b");
  });

  test("findPreliminary filters only preliminary entries", () => {
    repo.upsert({
      test_id: "test-prelim",
      difficulty: 0.5,
      discrimination: 1.0,
      guessing: 0.05,
      calibration_n: null,
      calibration_date: null,
      is_preliminary: 1,
      updated_at: "2026-01-10T12:00:00Z",
    });
    repo.upsert({
      test_id: "test-final",
      difficulty: 1.0,
      discrimination: 0.8,
      guessing: 0.1,
      calibration_n: 500,
      calibration_date: "2026-01-10",
      is_preliminary: 0,
      updated_at: "2026-01-10T12:00:00Z",
    });

    const preliminary = repo.findPreliminary();
    expect(preliminary).toHaveLength(1);
    expect(preliminary[0].test_id).toBe("test-prelim");
  });
});

// =====================================================
// COMPARISONS CRUD TESTS
// =====================================================
describe("ComparisonRepository", () => {
  let db: Database;
  let evalRepo: EvaluationRepository;
  let repo: ComparisonRepository;

  beforeEach(() => {
    db = setupDb();
    evalRepo = new EvaluationRepository(db);
    repo = new ComparisonRepository(db);
    evalRepo.create(makeEvaluation({ id: "eval-001" }));
    evalRepo.create(makeEvaluation({ id: "eval-002" }));
  });

  test("create and findByEvaluation", () => {
    repo.create({
      id: "cmp-001",
      baseline_evaluation_id: "eval-001",
      candidate_evaluation_id: "eval-002",
      dimension: "robustness",
      baseline_theta: 1.5,
      candidate_theta: 2.0,
      delta_theta: 0.5,
      cohens_d: 0.6,
      p_value: 0.03,
      statistical_power: 0.85,
      conclusion: "significant_improvement",
    });

    const byBaseline = repo.findByEvaluation("eval-001");
    expect(byBaseline).toHaveLength(1);
    expect(byBaseline[0].delta_theta).toBe(0.5);

    const byCandidate = repo.findByEvaluation("eval-002");
    expect(byCandidate).toHaveLength(1);
  });

  test("findByBaseline returns only baseline matches", () => {
    repo.create({
      id: "cmp-001",
      baseline_evaluation_id: "eval-001",
      candidate_evaluation_id: "eval-002",
      dimension: "robustness",
      baseline_theta: 1.5,
      candidate_theta: 2.0,
      delta_theta: 0.5,
      cohens_d: null,
      p_value: null,
      statistical_power: null,
      conclusion: null,
    });

    const results = repo.findByBaseline("eval-001");
    expect(results).toHaveLength(1);

    const noResults = repo.findByBaseline("eval-002");
    expect(noResults).toHaveLength(0);
  });

  test("create with null optional fields", () => {
    repo.create({
      id: "cmp-002",
      baseline_evaluation_id: "eval-001",
      candidate_evaluation_id: "eval-002",
      dimension: "fairness",
      baseline_theta: 0.8,
      candidate_theta: 0.9,
      delta_theta: 0.1,
      cohens_d: null,
      p_value: null,
      statistical_power: null,
      conclusion: null,
    });

    const found = repo.findByEvaluation("eval-001");
    expect(found).toHaveLength(1);
    expect(found[0].cohens_d).toBeNull();
    expect(found[0].conclusion).toBeNull();
  });
});

// =====================================================
// FK CONSTRAINTS AND CASCADE TESTS
// =====================================================
describe("FK constraints and CASCADE", () => {
  let db: Database;
  let evalRepo: EvaluationRepository;
  let testResultRepo: TestResultRepository;
  let irtRepo: IRTEstimateRepository;

  beforeEach(() => {
    db = setupDb();
    evalRepo = new EvaluationRepository(db);
    testResultRepo = new TestResultRepository(db);
    irtRepo = new IRTEstimateRepository(db);
  });

  test("deleting evaluation cascades to test_results", () => {
    evalRepo.create(makeEvaluation());
    testResultRepo.create(makeTestResult());

    // Verify test result exists
    expect(testResultRepo.findByEvaluation("eval-001")).toHaveLength(1);

    // Delete the evaluation
    db.prepare("DELETE FROM evaluations WHERE id = ?").run("eval-001");

    // Test results should be gone
    expect(testResultRepo.findByEvaluation("eval-001")).toHaveLength(0);
  });

  test("deleting evaluation cascades to irt_estimates", () => {
    evalRepo.create(makeEvaluation());
    irtRepo.upsert({
      evaluation_id: "eval-001",
      dimension: "robustness",
      theta: 1.5,
      se: 0.3,
      ci_lower: 0.9,
      ci_upper: 2.1,
      n_tests: 20,
      n_tests_exhaustive: null,
      convergence_test_number: null,
      normalized_score: null,
    });

    expect(irtRepo.findByEvaluation("eval-001")).toHaveLength(1);

    db.prepare("DELETE FROM evaluations WHERE id = ?").run("eval-001");

    expect(irtRepo.findByEvaluation("eval-001")).toHaveLength(0);
  });

  test("FK violation throws when inserting test_result with non-existent evaluation", () => {
    expect(() => {
      testResultRepo.create(makeTestResult({ evaluation_id: "non-existent-eval" }));
    }).toThrow();
  });
});

// =====================================================
// UNIQUE CONSTRAINT TESTS
// =====================================================
describe("UNIQUE constraints", () => {
  let db: Database;
  let evalRepo: EvaluationRepository;
  let testResultRepo: TestResultRepository;

  beforeEach(() => {
    db = setupDb();
    evalRepo = new EvaluationRepository(db);
    testResultRepo = new TestResultRepository(db);
    evalRepo.create(makeEvaluation());
  });

  test("duplicate (evaluation_id, test_id) in test_results throws", () => {
    testResultRepo.create(makeTestResult({ id: "tr-001", test_id: "test-001" }));
    expect(() => {
      testResultRepo.create(makeTestResult({ id: "tr-002", test_id: "test-001" }));
    }).toThrow();
  });

  test("same test_id in different evaluations is allowed", () => {
    evalRepo.create(makeEvaluation({ id: "eval-002" }));
    testResultRepo.create(
      makeTestResult({ id: "tr-001", evaluation_id: "eval-001", test_id: "test-001" }),
    );
    expect(() => {
      testResultRepo.create(
        makeTestResult({ id: "tr-002", evaluation_id: "eval-002", test_id: "test-001" }),
      );
    }).not.toThrow();
  });
});

// =====================================================
// JSON STORAGE/RETRIEVAL TESTS
// =====================================================
describe("JSON storage and retrieval", () => {
  let db: Database;
  let evalRepo: EvaluationRepository;
  let testResultRepo: TestResultRepository;

  beforeEach(() => {
    db = setupDb();
    evalRepo = new EvaluationRepository(db);
    testResultRepo = new TestResultRepository(db);
  });

  test("system_profile JSON round-trip", () => {
    const profile = {
      system_type: "chatbot",
      detection_confidence: 0.95,
      capabilities: ["text-generation", "multi-turn"],
    };
    evalRepo.create(makeEvaluation({ system_profile: JSON.stringify(profile) }));

    const found = evalRepo.findById("eval-001");
    expect(found).not.toBeNull();
    const profileJson = found ? found.system_profile : null;
    const parsed = JSON.parse(profileJson as string);
    expect(parsed.system_type).toBe("chatbot");
    expect(parsed.detection_confidence).toBe(0.95);
    expect(parsed.capabilities).toEqual(["text-generation", "multi-turn"]);
  });

  test("metrics JSON round-trip in test_results", () => {
    evalRepo.create(makeEvaluation());
    const metrics = {
      latency_p50: 120,
      latency_p95: 350,
      token_count: 45,
    };
    testResultRepo.create(makeTestResult({ metrics: JSON.stringify(metrics) }));

    const results = testResultRepo.findByEvaluation("eval-001");
    const parsed = JSON.parse(results[0].metrics as string);
    expect(parsed.latency_p50).toBe(120);
    expect(parsed.latency_p95).toBe(350);
    expect(parsed.token_count).toBe(45);
  });

  test("replications JSON round-trip in test_results", () => {
    evalRepo.create(makeEvaluation());
    const replications = [
      { passed: true, score: 0.9, duration_ms: 100 },
      { passed: false, score: 0.3, duration_ms: 110 },
      { passed: true, score: 0.85, duration_ms: 95 },
    ];
    testResultRepo.create(makeTestResult({ replications: JSON.stringify(replications) }));

    const results = testResultRepo.findByEvaluation("eval-001");
    const parsed = JSON.parse(results[0].replications as string);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].passed).toBe(true);
    expect(parsed[1].score).toBe(0.3);
  });
});

// =====================================================
// INDEX EXISTENCE TEST
// =====================================================
describe("Index existence", () => {
  test("all 5 indexes exist after migration", () => {
    const db = setupDb();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_test_results_evaluation");
    expect(indexNames).toContain("idx_test_results_dimension");
    expect(indexNames).toContain("idx_irt_estimates_evaluation");
    expect(indexNames).toContain("idx_evaluations_target");
    expect(indexNames).toContain("idx_evaluations_status");
    expect(indexNames).toHaveLength(5);
  });
});
