import type { EventBus } from "@apt/core/event-bus";
import type {
  ComplianceReport,
  ExecutionConfig,
  PlannedTest,
  SystemProfile,
  TestDefinition,
  TestDimension,
  TestPlan,
} from "@apt/lib/types";
import type { TestLibrary } from "./library/loader";

export class TestGenerator {
  constructor(
    private library: TestLibrary,
    private bus: EventBus,
  ) {}

  /**
   * Generate a TestPlan based on the system profile, optional compliance report,
   * and optional execution config.
   *
   * Steps:
   * 1. Filter tests by system_type from profile
   * 2. If compliance provided, prioritize tests mapped to requirements
   * 3. Convert TestDefinition[] to PlannedTest[]
   * 4. Calculate estimates based on mode
   * 5. Return TestPlan
   */
  async generate(
    profile: SystemProfile,
    compliance?: ComplianceReport,
    config?: ExecutionConfig,
  ): Promise<TestPlan> {
    // 1. Filter tests by system_type
    let tests = this.library.getBySystemType(profile.system_type);

    // 2. If compliance report provided, prioritize tests mapped to requirements
    if (compliance) {
      tests = this.prioritizeByCompliance(tests, compliance);
    }

    // 3. Convert to PlannedTest[]
    const plannedTests = tests.map((def) => {
      const planned = this.toPlannedTest(def);
      this.bus.emit("generator.test.selected", {
        test_id: planned.id,
        dimension: planned.dimension,
      });
      return planned;
    });

    // 4. Collect unique dimensions
    const dimensions = [...new Set(plannedTests.map((t) => t.dimension))] as TestDimension[];

    // 5. Calculate estimates
    const mode = config?.mode ?? "adaptive";
    const totalTests = plannedTests.length;
    const estimatedTests = mode === "adaptive" ? Math.ceil(totalTests * 0.4) : totalTests;

    const totalDurationMs = plannedTests.reduce((sum, t) => {
      // Use metadata estimated_duration or default 2500ms
      const testDef = this.library.getById(t.id);
      return sum + (testDef?.estimated_duration_ms ?? 2500);
    }, 0);

    const estimatedTimeMs =
      mode === "adaptive" ? Math.ceil(totalDurationMs * 0.4) : totalDurationMs;

    this.bus.emit("generator.completed", {
      total_tests: totalTests,
      dimensions: dimensions as string[],
      estimated_tests: estimatedTests,
    });

    return {
      tests: plannedTests,
      dimensions,
      strategy: mode,
      estimates: {
        estimated_tests: estimatedTests,
        estimated_time_ms: estimatedTimeMs,
      },
    };
  }

  /**
   * Convert a TestDefinition (YAML format) to a PlannedTest (pipeline format).
   */
  toPlannedTest(def: TestDefinition): PlannedTest {
    return {
      id: def.id,
      name: def.name,
      dimension: def.dimension,
      category: def.category,
      input: def.input,
      expected_behavior: def.expected.behavior,
      irt_params: {
        alpha: def.irt.discrimination,
        beta: def.irt.difficulty,
        gamma: def.irt.guessing,
      },
      metadata: {
        evaluators: def.expected.evaluators,
        tags: def.tags,
        backends: def.backends,
        is_preliminary: def.irt.is_preliminary,
        compliance: def.compliance,
      },
    };
  }

  /**
   * Score tests by how many compliance requirements they map to.
   * Higher score = higher priority. Sort descending by score.
   */
  prioritizeByCompliance(tests: TestDefinition[], compliance: ComplianceReport): TestDefinition[] {
    // Collect all requirement IDs from the compliance report
    const requirementIds = new Set<string>();
    for (const standard of compliance.standards) {
      for (const req of standard.requirements) {
        requirementIds.add(req.id);
      }
    }

    // Also consider gaps as high-priority requirements
    const gapIds = new Set<string>();
    for (const gap of compliance.gaps) {
      gapIds.add(gap.requirement_id);
    }

    // Score each test
    const scored = tests.map((test) => {
      let score = 0;

      if (test.compliance) {
        for (const mapping of test.compliance) {
          // Score for matching a compliance requirement
          if (requirementIds.has(mapping.article)) {
            score += 1;
          }
          // Extra score for matching a gap (higher priority)
          if (gapIds.has(mapping.article)) {
            score += 2;
          }
        }
      }

      return { test, score };
    });

    // Sort descending by score (compliance-relevant tests first)
    scored.sort((a, b) => b.score - a.score);

    return scored.map((s) => s.test);
  }
}

export { TestLibrary } from "./library/loader";
