import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalysisReport, TestDimension } from "@apt/lib/types";
import { HtmlReporter } from "@apt/modules/analyzer/reports/html-reporter";
import { JsonReporter } from "@apt/modules/analyzer/reports/json-reporter";

// --- Helper: create a realistic AnalysisReport ---
function makeReport(dimensionCount = 3): AnalysisReport {
  const dims: Array<{
    dimension: TestDimension;
    theta: number;
    se: number;
    normalized_score: number;
    grade: string;
    n_tests: number;
    ci_lower: number;
    ci_upper: number;
  }> = [];

  const allDimensions: TestDimension[] = [
    "security",
    "robustness",
    "functional",
    "fairness",
    "performance",
    "compliance",
  ];
  const scores = [70, 42, 93, 60, 78, 85];
  const grades = ["B", "D", "A", "C", "B", "A"];

  for (let i = 0; i < dimensionCount && i < allDimensions.length; i++) {
    dims.push({
      dimension: allDimensions[i],
      theta: (scores[i] - 50) / 30,
      se: 0.3,
      normalized_score: scores[i],
      grade: grades[i],
      n_tests: 5 + i,
      ci_lower: (scores[i] - 50) / 30 - 0.58,
      ci_upper: (scores[i] - 50) / 30 + 0.58,
    });
  }

  const overall = dims.reduce((s, d) => s + d.normalized_score, 0) / dims.length;
  const overallGrade =
    overall >= 85 ? "A" : overall >= 70 ? "B" : overall >= 55 ? "C" : overall >= 40 ? "D" : "F";

  return {
    evaluation_id: "test-report-001",
    summary: {
      overall_score: overall,
      overall_grade: overallGrade,
      dimensions_tested: dims.length,
      total_tests: dims.reduce((s, d) => s + d.n_tests, 0),
      duration_ms: 5000,
    },
    dimensions: dims,
    compliance: null,
    drift: null,
    comparisons: [],
    recommendations: [
      {
        dimension: "robustness",
        priority: "high",
        description:
          "robustness score is critically low (42.0%, grade D). Immediate improvements needed.",
      },
      {
        dimension: "security",
        priority: "medium",
        description: "security score is good but can be improved (70.0%, grade B).",
      },
    ],
    trace: {
      pipeline_version: "0.1.0",
      started_at: "2026-02-17T10:00:00.000Z",
      completed_at: "2026-02-17T10:00:05.000Z",
      modules: ["introspector", "generator", "executor", "analyzer"],
    },
  };
}

describe("JsonReporter", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "apt-report-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  test("writes a valid JSON file", async () => {
    const reporter = new JsonReporter();
    const report = makeReport();
    const path = await reporter.generate(report, tmpDir);

    const file = Bun.file(path);
    expect(await file.exists()).toBe(true);

    const content = await file.text();
    const parsed = JSON.parse(content);
    expect(parsed).toBeDefined();
  });

  test("JSON contains all required sections", async () => {
    const reporter = new JsonReporter();
    const report = makeReport();
    const path = await reporter.generate(report, tmpDir);

    const content = await Bun.file(path).text();
    const parsed = JSON.parse(content);

    expect(parsed.evaluation_id).toBe("test-report-001");
    expect(parsed.summary).toBeDefined();
    expect(parsed.summary.overall_score).toBeDefined();
    expect(parsed.summary.overall_grade).toBeDefined();
    expect(parsed.dimensions).toBeDefined();
    expect(parsed.dimensions.length).toBe(3);
    expect(parsed.recommendations).toBeDefined();
    expect(parsed.recommendations.length).toBe(2);
    expect(parsed.trace).toBeDefined();
    expect(parsed.trace.pipeline_version).toBe("0.1.0");
  });
});

describe("HtmlReporter", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "apt-report-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  test("writes an HTML file", async () => {
    const reporter = new HtmlReporter();
    const report = makeReport();
    const path = await reporter.generate(report, tmpDir);

    const file = Bun.file(path);
    expect(await file.exists()).toBe(true);

    const content = await file.text();
    expect(content.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  test("HTML contains overall score", async () => {
    const reporter = new HtmlReporter();
    const report = makeReport();
    const path = await reporter.generate(report, tmpDir);

    const content = await Bun.file(path).text();
    expect(content).toContain(report.summary.overall_score.toFixed(1));
    expect(content).toContain(`grade-${report.summary.overall_grade}`);
  });

  test("HTML contains dimension table", async () => {
    const reporter = new HtmlReporter();
    const report = makeReport();
    const path = await reporter.generate(report, tmpDir);

    const content = await Bun.file(path).text();

    // Check all dimensions appear in the table
    for (const dim of report.dimensions) {
      expect(content).toContain(dim.dimension);
      expect(content).toContain(`grade-${dim.grade}`);
    }

    // Check the table header
    expect(content).toContain("<th>Dimension</th>");
    expect(content).toContain("<th>Score</th>");
    expect(content).toContain("<th>Grade</th>");
  });

  test("HTML contains SVG radar chart for 3+ dimensions", async () => {
    const reporter = new HtmlReporter();
    const report = makeReport(4); // 4 dimensions to trigger radar chart
    const path = await reporter.generate(report, tmpDir);

    const content = await Bun.file(path).text();

    expect(content).toContain("<svg");
    expect(content).toContain("</svg>");
    expect(content).toContain("<polygon");
    expect(content).toContain("Dimension Overview");
  });

  test("HTML is self-contained — no external links", async () => {
    const reporter = new HtmlReporter();
    const report = makeReport(4);
    const path = await reporter.generate(report, tmpDir);

    const content = await Bun.file(path).text();

    // Must not contain http:// or https:// links (CDN, external CSS/JS)
    expect(content).not.toMatch(/https?:\/\//);
  });
});
