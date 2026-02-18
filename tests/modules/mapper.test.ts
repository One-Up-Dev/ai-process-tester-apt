import { beforeEach, describe, expect, test } from "bun:test";
import { EventBus } from "@apt/core/event-bus";
import type {
  ComplianceConfig,
  SystemProfile,
  SystemType,
  TestCategory,
  TestDefinition,
  TestDimension,
} from "@apt/lib/types";
import { ComplianceMapper } from "@apt/modules/mapper/index";
import {
  type Clause,
  buildTraceabilityMatrix,
  calculateCoverage,
  matchPattern,
} from "@apt/modules/mapper/traceability";

// Helper to create a minimal TestDefinition
function makeTestDef(id: string, overrides?: Partial<TestDefinition>): TestDefinition {
  return {
    id,
    version: "1.0.0",
    name: id,
    description: `Test ${id}`,
    category: (overrides?.category ?? "functional") as TestCategory,
    dimension: (overrides?.dimension ?? "functional") as TestDimension,
    system_types: (overrides?.system_types ?? ["chatbot"]) as SystemType[],
    irt: {
      difficulty: 0,
      discrimination: 1,
      guessing: 0.05,
      calibration_n: 0,
      calibration_date: "2026-01-01",
      is_preliminary: true,
    },
    input: { type: "text", content: "test" },
    expected: {
      behavior: "test",
      evaluators: [{ type: "contains", value: "test" }],
    },
    tags: [],
    backends: ["built-in"],
    estimated_duration_ms: 1000,
    ...overrides,
  };
}

// Minimal SystemProfile
function makeProfile(): SystemProfile {
  return {
    id: "test-profile",
    detected_at: new Date().toISOString(),
    system_type: "chatbot",
    detection_confidence: 1.0,
    detection_methods: [],
    input_interfaces: [{ type: "text", format: "json" }],
    output_interfaces: [{ type: "text", format: "text" }],
    capabilities: ["chatbot"],
    dependencies: [],
    adapter: { url: "http://localhost:3000", adapter: "http" },
  };
}

describe("matchPattern", () => {
  test("matches exact wildcard pattern 'security.*'", () => {
    expect(matchPattern("security.prompt-injection-basic.011", "security.*")).toBe(true);
    expect(matchPattern("security.data-leakage", "security.*")).toBe(true);
    expect(matchPattern("robustness.foo", "security.*")).toBe(false);
  });

  test("matches partial wildcard 'robustness.adversarial*'", () => {
    expect(
      matchPattern("robustness.adversarial-instruction-override.006", "robustness.adversarial*"),
    ).toBe(true);
    expect(matchPattern("robustness.adversarial-role-play.007", "robustness.adversarial*")).toBe(
      true,
    );
    expect(matchPattern("robustness.edge-case-empty", "robustness.adversarial*")).toBe(false);
  });

  test("matches exact ID with no wildcard", () => {
    expect(matchPattern("functional.accuracy.001", "functional.accuracy.001")).toBe(true);
    expect(matchPattern("functional.accuracy.002", "functional.accuracy.001")).toBe(false);
  });
});

describe("buildTraceabilityMatrix", () => {
  const tests: TestDefinition[] = [
    makeTestDef("security.injection.001", { category: "security", dimension: "security" }),
    makeTestDef("security.leakage.002", { category: "security", dimension: "security" }),
    makeTestDef("robustness.adversarial.001", { category: "robustness", dimension: "robustness" }),
    makeTestDef("functional.accuracy.001", { category: "functional", dimension: "functional" }),
  ];

  test("covered when all patterns match", () => {
    const clauses: Clause[] = [
      {
        id: "c-1",
        text: "Security requirement",
        testable: true,
        tests: ["security.*"],
        criticality: "critical",
      },
    ];
    const matrix = buildTraceabilityMatrix(clauses, tests);
    expect(matrix).toHaveLength(1);
    expect(matrix[0].status).toBe("covered");
    expect(matrix[0].mapped_tests).toContain("security.injection.001");
    expect(matrix[0].mapped_tests).toContain("security.leakage.002");
  });

  test("partial when only some patterns match", () => {
    const clauses: Clause[] = [
      {
        id: "c-2",
        text: "Needs both coverage",
        testable: true,
        tests: ["security.*", "nonexistent.*"],
        criticality: "major",
      },
    ];
    const matrix = buildTraceabilityMatrix(clauses, tests);
    expect(matrix[0].status).toBe("partial");
  });

  test("not_covered when no patterns match", () => {
    const clauses: Clause[] = [
      {
        id: "c-3",
        text: "Missing coverage",
        testable: true,
        tests: ["compliance.*"],
        criticality: "minor",
      },
    ];
    const matrix = buildTraceabilityMatrix(clauses, tests);
    expect(matrix[0].status).toBe("not_covered");
    expect(matrix[0].mapped_tests).toHaveLength(0);
  });

  test("excludes non-testable clauses", () => {
    const clauses: Clause[] = [
      {
        id: "c-4",
        text: "Not testable",
        testable: false,
        tests: ["security.*"],
        criticality: "critical",
      },
    ];
    const matrix = buildTraceabilityMatrix(clauses, tests);
    expect(matrix).toHaveLength(0);
  });
});

describe("calculateCoverage", () => {
  test("computes correct stats", () => {
    const matrix = [
      {
        requirement_id: "a",
        requirement_text: "a",
        criticality: "critical" as const,
        mapped_tests: ["t1"],
        status: "covered" as const,
      },
      {
        requirement_id: "b",
        requirement_text: "b",
        criticality: "major" as const,
        mapped_tests: ["t2"],
        status: "partial" as const,
      },
      {
        requirement_id: "c",
        requirement_text: "c",
        criticality: "minor" as const,
        mapped_tests: [],
        status: "not_covered" as const,
      },
    ];
    const coverage = calculateCoverage(matrix);
    expect(coverage.total).toBe(3);
    expect(coverage.covered).toBe(1);
    expect(coverage.partial).toBe(1);
    expect(coverage.not_covered).toBe(1);
    // percentage = (1/3) * 100 = 33.33
    expect(coverage.percentage).toBeCloseTo(33.33, 1);
  });

  test("returns 0% for empty matrix", () => {
    const coverage = calculateCoverage([]);
    expect(coverage.total).toBe(0);
    expect(coverage.percentage).toBe(0);
  });
});

describe("ComplianceMapper", () => {
  let bus: EventBus;
  let mapper: ComplianceMapper;
  let profile: SystemProfile;

  beforeEach(() => {
    bus = new EventBus();
    mapper = new ComplianceMapper(bus);
    profile = makeProfile();
  });

  test("loads EU AI Act standard and emits event", async () => {
    let loadedStandard = "";
    bus.on("mapper.standard.loaded", (data) => {
      loadedStandard = data.standard;
    });

    const compliance: ComplianceConfig = {
      jurisdiction: "EU",
      risk_classification: "high-risk",
      sector: "general",
      standards: ["eu-ai-act"],
      exclusions: [],
    };

    const tests = [
      makeTestDef("robustness.adversarial.001", {
        category: "robustness",
        dimension: "robustness",
      }),
      makeTestDef("security.prompt-injection.001", { category: "security", dimension: "security" }),
    ];

    const report = await mapper.map(profile, compliance, tests);
    expect(loadedStandard).toBe("EU AI Act (Regulation 2024/1689)");
    expect(report.jurisdiction).toBe("EU");
    expect(report.risk_classification).toBe("high-risk");
    expect(report.standards).toHaveLength(1);
    expect(report.standards[0].name).toBe("EU AI Act (Regulation 2024/1689)");
  });

  test("filters clauses by risk_level (high-risk gets clauses)", async () => {
    const compliance: ComplianceConfig = {
      jurisdiction: "EU",
      risk_classification: "high-risk",
      sector: "general",
      standards: ["eu-ai-act"],
      exclusions: [],
    };

    const tests = [
      makeTestDef("security.prompt-injection.001", { category: "security", dimension: "security" }),
    ];

    const report = await mapper.map(profile, compliance, tests);
    expect(report.standards[0].requirements.length).toBeGreaterThan(0);
  });

  test("filters clauses by risk_level (minimal gets no clauses)", async () => {
    const compliance: ComplianceConfig = {
      jurisdiction: "EU",
      risk_classification: "minimal",
      sector: "general",
      standards: ["eu-ai-act"],
      exclusions: [],
    };

    const report = await mapper.map(profile, compliance, []);
    // minimal risk has no matching articles in eu-ai-act
    expect(report.standards[0].requirements).toHaveLength(0);
  });

  test("detects gaps and emits events", async () => {
    const gapEvents: Array<{ requirement: string; criticality: string }> = [];
    bus.on("mapper.gap.detected", (data) => {
      gapEvents.push(data);
    });

    const compliance: ComplianceConfig = {
      jurisdiction: "EU",
      risk_classification: "high-risk",
      sector: "general",
      standards: ["eu-ai-act"],
      exclusions: [],
    };

    // No tests provided -> all testable clauses become gaps
    const report = await mapper.map(profile, compliance, []);
    expect(report.gaps.length).toBeGreaterThan(0);
    expect(gapEvents.length).toBeGreaterThan(0);
    expect(gapEvents[0].requirement).toBeDefined();
  });

  test("builds correct traceability matrix record", async () => {
    const compliance: ComplianceConfig = {
      jurisdiction: "EU",
      risk_classification: "high-risk",
      sector: "general",
      standards: ["eu-ai-act"],
      exclusions: [],
    };

    const tests = [
      makeTestDef("security.prompt-injection.001", { category: "security", dimension: "security" }),
      makeTestDef("robustness.adversarial.001", {
        category: "robustness",
        dimension: "robustness",
      }),
    ];

    const report = await mapper.map(profile, compliance, tests);
    expect(report.traceability_matrix).toBeDefined();
    expect(typeof report.traceability_matrix).toBe("object");
    // Should have entries for testable requirements
    const keys = Object.keys(report.traceability_matrix);
    expect(keys.length).toBeGreaterThan(0);
  });

  test("unknown standard returns empty report", async () => {
    const compliance: ComplianceConfig = {
      jurisdiction: "EU",
      risk_classification: "high-risk",
      sector: "general",
      standards: ["nonexistent-standard"],
      exclusions: [],
    };

    const report = await mapper.map(profile, compliance, []);
    expect(report.standards).toHaveLength(0);
    expect(report.gaps).toHaveLength(0);
    expect(report.traceability_matrix).toEqual({});
  });
});
