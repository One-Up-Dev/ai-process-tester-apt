import type { TestDefinition } from "@apt/lib/types";

export interface Clause {
  id: string;
  text: string;
  testable: boolean;
  tests: string[]; // glob patterns like "security.*"
  criticality: "critical" | "major" | "minor";
}

export interface TraceabilityEntry {
  requirement_id: string;
  requirement_text: string;
  criticality: "critical" | "major" | "minor";
  mapped_tests: string[];
  status: "covered" | "partial" | "not_covered";
}

/**
 * Build a traceability matrix mapping clauses to available tests.
 *
 * For each testable clause:
 * 1. Match clause.tests patterns against test IDs (glob-like matching with * wildcard)
 * 2. If ALL patterns have at least one match -> "covered"
 * 3. If SOME patterns match but not all -> "partial"
 * 4. If NO patterns match at all -> "not_covered"
 */
export function buildTraceabilityMatrix(
  clauses: Clause[],
  availableTests: TestDefinition[],
): TraceabilityEntry[] {
  return clauses
    .filter((c) => c.testable)
    .map((clause) => {
      const matchedTestIds = new Set<string>();
      let patternsMatched = 0;

      for (const pattern of clause.tests) {
        let patternHasMatch = false;
        for (const test of availableTests) {
          if (matchPattern(test.id, pattern)) {
            matchedTestIds.add(test.id);
            patternHasMatch = true;
          }
        }
        if (patternHasMatch) {
          patternsMatched++;
        }
      }

      const totalPatterns = clause.tests.length;
      let status: TraceabilityEntry["status"];

      if (totalPatterns === 0 || patternsMatched === 0) {
        status = "not_covered";
      } else if (patternsMatched === totalPatterns) {
        status = "covered";
      } else {
        status = "partial";
      }

      return {
        requirement_id: clause.id,
        requirement_text: clause.text,
        criticality: clause.criticality,
        mapped_tests: [...matchedTestIds],
        status,
      };
    });
}

export function calculateCoverage(matrix: TraceabilityEntry[]): {
  total: number;
  covered: number;
  partial: number;
  not_covered: number;
  percentage: number;
} {
  const total = matrix.length;
  const covered = matrix.filter((e) => e.status === "covered").length;
  const partial = matrix.filter((e) => e.status === "partial").length;
  const not_covered = matrix.filter((e) => e.status === "not_covered").length;
  const percentage = total > 0 ? Math.round((covered / total) * 100 * 100) / 100 : 0;

  return { total, covered, partial, not_covered, percentage };
}

/**
 * Match a test ID against a glob pattern with * wildcard.
 * "security.*" -> /^security\..*$/
 * "robustness.adversarial*" -> /^robustness\.adversarial.*$/
 */
export function matchPattern(testId: string, pattern: string): boolean {
  const regex = new RegExp(`^${pattern.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`);
  return regex.test(testId);
}
