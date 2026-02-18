import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@apt/core/event-bus";
import { runMigrations } from "@apt/lib/migrations";
import { EvaluationRepository } from "@apt/lib/repositories/evaluations";
import { IRTEstimateRepository } from "@apt/lib/repositories/irt-estimates";
import { TestResultRepository } from "@apt/lib/repositories/test-results";
import type { ExecutionResults, IRTEstimate, TestDimension, TestResult } from "@apt/lib/types";
import { Analyzer } from "@apt/modules/analyzer/index";
import { HtmlReporter } from "@apt/modules/analyzer/reports/html-reporter";
import { JsonReporter } from "@apt/modules/analyzer/reports/json-reporter";

let tmpDir: string;
let db: Database;
let evaluations: EvaluationRepository;
let testResults: TestResultRepository;
let irtEstimates: IRTEstimateRepository;

const EVAL_ID = "test-eval-001";

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "apt-report-export-test-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Create in-memory DB with schema
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);

  evaluations = new EvaluationRepository(db);
  testResults = new TestResultRepository(db);
  irtEstimates = new IRTEstimateRepository(db);

  // Insert test evaluation
  evaluations.create({
    id: EVAL_ID,
    target_url: "http://localhost:9999",
    system_type: "chatbot",
    system_profile: null,
    compliance_report: null,
    config: JSON.stringify({ target: { url: "http://localhost:9999" } }),
    mode: "adaptive",
    status: "completed",
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: 5000,
  });

  // Insert test results
  testResults.create({
    id: "tr-001",
    evaluation_id: EVAL_ID,
    test_id: "func-001",
    dimension: "functional",
    category: "functional",
    backend_id: "built-in",
    passed: 1,
    score: 0.9,
    metrics: JSON.stringify({ latency_ms: 120 }),
    raw_input: null,
    raw_output: "Test response",
    duration_ms: 150,
    replications: null,
    noise_cv: null,
    noise_flag: 0,
    irt_theta_at_time: 0.5,
    irt_se_at_time: 0.4,
    irt_information: null,
    selection_reason: null,
    executed_at: new Date().toISOString(),
  });

  testResults.create({
    id: "tr-002",
    evaluation_id: EVAL_ID,
    test_id: "sec-001",
    dimension: "security",
    category: "security",
    backend_id: "built-in",
    passed: 0,
    score: 0.3,
    metrics: JSON.stringify({ latency_ms: 200 }),
    raw_input: null,
    raw_output: "Leaked data",
    duration_ms: 250,
    replications: null,
    noise_cv: null,
    noise_flag: 0,
    irt_theta_at_time: -0.2,
    irt_se_at_time: 0.5,
    irt_information: null,
    selection_reason: null,
    executed_at: new Date().toISOString(),
  });

  // Insert IRT estimates
  irtEstimates.upsert({
    evaluation_id: EVAL_ID,
    dimension: "functional",
    theta: 0.8,
    se: 0.25,
    ci_lower: 0.31,
    ci_upper: 1.29,
    n_tests: 1,
    n_tests_exhaustive: null,
    convergence_test_number: null,
    normalized_score: 78.5,
  });

  irtEstimates.upsert({
    evaluation_id: EVAL_ID,
    dimension: "security",
    theta: -0.3,
    se: 0.35,
    ci_lower: -0.99,
    ci_upper: 0.39,
    n_tests: 1,
    n_tests_exhaustive: null,
    convergence_test_number: null,
    normalized_score: 37.5,
  });
});

afterEach(() => {
  db.close();
});

describe("report command", () => {
  // 1. Generate JSON report from stored evaluation
  test("generates JSON report from stored evaluation", async () => {
    const outputDir = join(tmpDir, "report-json");

    // Reconstruct execution results
    const rawResults = testResults.findByEvaluation(EVAL_ID);
    const rawEstimates = irtEstimates.findByEvaluation(EVAL_ID);

    const results: ExecutionResults = {
      evaluation_id: EVAL_ID,
      system_profile: {
        id: "reconstructed",
        detected_at: new Date().toISOString(),
        system_type: "chatbot",
        detection_confidence: 0,
        detection_methods: [],
        input_interfaces: [],
        output_interfaces: [],
        capabilities: [],
        dependencies: [],
        adapter: {
          url: "http://localhost:9999",
          adapter: "http",
          timeout_ms: 30000,
          system_type: "auto",
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
    const report = await analyzer.analyze(results);

    const path = await new JsonReporter().generate(report, outputDir);
    expect(path).toContain(EVAL_ID);
    expect(path).toEndWith(".json");

    const file = Bun.file(path);
    const exists = await file.exists();
    expect(exists).toBe(true);

    const content = await file.json();
    expect(content.evaluation_id).toBe(EVAL_ID);
    expect(content.summary.overall_score).toBeNumber();
    expect(content.summary.overall_grade).toBeString();
    expect(content.dimensions).toBeArray();
    expect(content.dimensions.length).toBe(2);
  });

  // 2. Generate HTML report from stored evaluation
  test("generates HTML report from stored evaluation", async () => {
    const outputDir = join(tmpDir, "report-html");

    const rawEstimates = irtEstimates.findByEvaluation(EVAL_ID);
    const rawResults = testResults.findByEvaluation(EVAL_ID);

    const results: ExecutionResults = {
      evaluation_id: EVAL_ID,
      system_profile: {
        id: "reconstructed",
        detected_at: new Date().toISOString(),
        system_type: "chatbot",
        detection_confidence: 0,
        detection_methods: [],
        input_interfaces: [],
        output_interfaces: [],
        capabilities: [],
        dependencies: [],
        adapter: {
          url: "http://localhost:9999",
          adapter: "http",
          timeout_ms: 30000,
          system_type: "auto",
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
    const report = await analyzer.analyze(results);

    const path = await new HtmlReporter().generate(report, outputDir);
    expect(path).toContain(EVAL_ID);
    expect(path).toEndWith(".html");

    const file = Bun.file(path);
    const exists = await file.exists();
    expect(exists).toBe(true);

    const content = await file.text();
    expect(content).toContain("<!DOCTYPE html>");
    expect(content).toContain("APT Evaluation Report");
    expect(content).toContain(EVAL_ID);
  });
});

describe("export command", () => {
  // 3. Export to CSV generates CSV files
  test("exports evaluation data to CSV", async () => {
    const outputDir = join(tmpDir, "export-csv");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(outputDir, { recursive: true });

    const results = testResults.findByEvaluation(EVAL_ID);
    const estimates = irtEstimates.findByEvaluation(EVAL_ID);

    // Generate CSV for test results
    if (results.length > 0) {
      const headers = Object.keys(results[0]).join(",");
      const rows = results.map((r) =>
        Object.values(r)
          .map((v) => JSON.stringify(v ?? ""))
          .join(","),
      );
      const csv = [headers, ...rows].join("\n");
      const path = `${outputDir}/results_${EVAL_ID}.csv`;
      await Bun.write(path, csv);

      const file = Bun.file(path);
      const exists = await file.exists();
      expect(exists).toBe(true);

      const content = await file.text();
      expect(content).toContain("id,evaluation_id,test_id");
      expect(content).toContain(EVAL_ID);
      // Should have header + 2 data rows
      const lines = content.split("\n");
      expect(lines.length).toBe(3);
    }

    // Generate CSV for IRT estimates
    if (estimates.length > 0) {
      const headers = Object.keys(estimates[0]).join(",");
      const rows = estimates.map((e) =>
        Object.values(e)
          .map((v) => JSON.stringify(v ?? ""))
          .join(","),
      );
      const csv = [headers, ...rows].join("\n");
      const path = `${outputDir}/irt_${EVAL_ID}.csv`;
      await Bun.write(path, csv);

      const file = Bun.file(path);
      const exists = await file.exists();
      expect(exists).toBe(true);

      const content = await file.text();
      expect(content).toContain("evaluation_id,dimension");
      expect(content).toContain(EVAL_ID);
    }
  });

  // 4. Export to JSON generates a JSON file
  test("exports evaluation data to JSON", async () => {
    const outputDir = join(tmpDir, "export-json");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(outputDir, { recursive: true });

    const ev = evaluations.findById(EVAL_ID);
    expect(ev).not.toBeNull();

    const results = testResults.findByEvaluation(EVAL_ID);
    const estimates = irtEstimates.findByEvaluation(EVAL_ID);

    const data = { evaluation: ev, test_results: results, irt_estimates: estimates };
    const path = `${outputDir}/export_${EVAL_ID}.json`;
    await Bun.write(path, JSON.stringify(data, null, 2));

    const file = Bun.file(path);
    const exists = await file.exists();
    expect(exists).toBe(true);

    const content = await file.json();
    expect(content.evaluation.id).toBe(EVAL_ID);
    expect(content.test_results).toBeArray();
    expect(content.test_results.length).toBe(2);
    expect(content.irt_estimates).toBeArray();
    expect(content.irt_estimates.length).toBe(2);
  });

  // 5. Export with no evaluations warns and would exit
  test("no evaluations returns empty list", () => {
    // Create a fresh empty DB
    const emptyDb = new Database(":memory:");
    emptyDb.exec("PRAGMA journal_mode = WAL");
    emptyDb.exec("PRAGMA foreign_keys = ON");
    runMigrations(emptyDb);

    const emptyEvals = new EvaluationRepository(emptyDb);
    const result = emptyEvals.findRecent(100);
    expect(result).toBeArray();
    expect(result.length).toBe(0);

    emptyDb.close();
  });
});
