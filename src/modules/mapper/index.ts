import type { EventBus } from "@apt/core/event-bus";
import type {
  ComplianceConfig,
  ComplianceReport,
  SystemProfile,
  TestDefinition,
} from "@apt/lib/types";
import { parse } from "yaml";
import { type Clause, buildTraceabilityMatrix, calculateCoverage } from "./traceability";

export class ComplianceMapper {
  constructor(private bus: EventBus) {}

  async map(
    _profile: SystemProfile,
    compliance: ComplianceConfig,
    availableTests: TestDefinition[],
  ): Promise<ComplianceReport> {
    // 1. Load standard YAML file based on compliance.standards[0]
    const standardId = compliance.standards[0] ?? "eu-ai-act";
    const standardPath = `${import.meta.dir}/standards/${standardId}.yaml`;
    const standardFile = Bun.file(standardPath);

    if (!(await standardFile.exists())) {
      // If standard not found, return empty report
      return this.emptyReport(compliance);
    }

    const standardData = parse(await standardFile.text()) as {
      standard: { id: string; name: string; version: string; jurisdiction: string };
      articles: Array<{
        id: string;
        title: string;
        risk_levels: string[];
        clauses: Array<{
          id: string;
          text: string;
          testable: boolean;
          tests?: string[];
          criticality: "critical" | "major" | "minor";
        }>;
      }>;
    };
    this.bus.emit("mapper.standard.loaded", { standard: standardData.standard.name });

    // 2. Extract clauses, filter by risk_level
    const clauses: Clause[] = [];
    for (const article of standardData.articles) {
      // Check if risk level matches
      if (!article.risk_levels.includes(compliance.risk_classification)) continue;

      for (const clause of article.clauses) {
        if (clause.testable) {
          clauses.push({
            id: clause.id,
            text: clause.text,
            testable: true,
            tests: clause.tests ?? [],
            criticality: clause.criticality,
          });
        }
      }
    }

    // 3. Build traceability matrix
    const matrix = buildTraceabilityMatrix(clauses, availableTests);
    const _coverage = calculateCoverage(matrix);

    // 4. Identify gaps
    const gaps = matrix
      .filter((e) => e.status === "not_covered")
      .map((e) => ({
        requirement_id: e.requirement_id,
        description: e.requirement_text,
        criticality: e.criticality,
      }));

    // Emit gap events
    for (const gap of gaps) {
      this.bus.emit("mapper.gap.detected", {
        requirement: gap.requirement_id,
        criticality: gap.criticality,
      });
    }

    // 5. Build requirements list
    const requirements = matrix.map((e) => ({
      id: e.requirement_id,
      description: e.requirement_text,
      criticality: e.criticality,
      mapped_tests: e.mapped_tests,
    }));

    // 6. Build traceability_matrix as Record
    const traceabilityRecord: Record<string, string[]> = {};
    for (const entry of matrix) {
      traceabilityRecord[entry.requirement_id] = entry.mapped_tests;
    }

    return {
      jurisdiction: compliance.jurisdiction,
      risk_classification: compliance.risk_classification,
      standards: [
        {
          name: standardData.standard.name,
          requirements,
        },
      ],
      gaps,
      traceability_matrix: traceabilityRecord,
    };
  }

  private emptyReport(compliance: ComplianceConfig): ComplianceReport {
    return {
      jurisdiction: compliance.jurisdiction,
      risk_classification: compliance.risk_classification,
      standards: [],
      gaps: [],
      traceability_matrix: {},
    };
  }
}
