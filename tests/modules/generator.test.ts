import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@apt/core/event-bus";
import { TestDefinitionSchema } from "@apt/lib/schema";
import type { ComplianceReport, ExecutionConfig, SystemProfile } from "@apt/lib/types";
import { TestGenerator } from "@apt/modules/generator";
import { TestLibrary } from "@apt/modules/generator/library/loader";

const LIBRARY_DIR = join(import.meta.dir, "..", "..", "library");

// --- Helper: minimal SystemProfile ---
function makeProfile(
  systemType: "chatbot" | "rag" | "classifier" | "agent" = "chatbot",
): SystemProfile {
  return {
    id: "test-profile-1",
    detected_at: "2026-02-17T00:00:00Z",
    system_type: systemType,
    detection_confidence: 0.95,
    detection_methods: [
      {
        method: "probe",
        confidence: 0.95,
        evidence: {},
      },
    ],
    input_interfaces: [{ type: "text", format: "plain" }],
    output_interfaces: [{ type: "text", format: "plain" }],
    capabilities: ["text-generation"],
    dependencies: [{ provider: "openai", model: "gpt-4" }],
    adapter: {
      url: "http://localhost:3000",
      adapter: "http",
    },
  };
}

// --- Helper: minimal ComplianceReport ---
function makeCompliance(): ComplianceReport {
  return {
    jurisdiction: "EU",
    risk_classification: "high-risk",
    standards: [
      {
        name: "eu-ai-act",
        requirements: [
          {
            id: "art-15-3",
            description: "Robustness against manipulation",
            criticality: "critical",
            mapped_tests: [],
          },
          {
            id: "art-15-4",
            description: "Security against adversarial inputs",
            criticality: "critical",
            mapped_tests: [],
          },
          {
            id: "art-10-2-f",
            description: "Fairness and non-discrimination",
            criticality: "major",
            mapped_tests: [],
          },
        ],
      },
    ],
    gaps: [
      {
        requirement_id: "art-15-3",
        description: "No robustness tests mapped",
        criticality: "critical",
      },
    ],
    traceability_matrix: {},
  };
}

// =============================================================
// TEST LIBRARY — LOADER
// =============================================================
describe("TestLibrary — Loader", () => {
  test("loads a valid YAML file from a directory", async () => {
    const lib = new TestLibrary();
    // Load only the chatbot/functional subdir (5 files)
    await lib.loadDirectory(join(LIBRARY_DIR, "chatbot", "functional"));
    expect(lib.count()).toBe(5);
  });

  test("loads a recursive directory with nested subdirs", async () => {
    const lib = new TestLibrary();
    await lib.loadDirectory(join(LIBRARY_DIR, "chatbot"));
    // chatbot has: functional(5) + robustness(5) + security(4) + fairness(2) + performance(4) = 20
    expect(lib.count()).toBe(20);
  });

  test("Zod validation: invalid test — missing required field", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "apt-test-"));
    const invalidYaml = `
id: "test.invalid.001"
version: "1.0.0"
# missing: name, description, category, dimension, etc.
`;
    await Bun.write(join(tmpDir, "invalid.yaml"), invalidYaml);

    const lib = new TestLibrary();
    expect(lib.loadDirectory(tmpDir)).rejects.toThrow("Validation failed");

    await rm(tmpDir, { recursive: true });
  });

  test("Zod validation: invalid test — negative discrimination", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "apt-test-"));
    const invalidYaml = `
id: "test.invalid.002"
version: "1.0.0"
name: "Invalid Test"
description: "Has negative discrimination"
category: functional
dimension: functional
system_types: [chatbot]
irt:
  difficulty: 0.5
  discrimination: -1.0
  guessing: 0.05
  calibration_n: 0
  calibration_date: "2026-02-17"
  is_preliminary: true
input:
  type: text
  content: "test"
expected:
  behavior: "test"
  evaluators:
    - type: contains
      value: "test"
tags: [test]
backends: [built-in]
estimated_duration_ms: 1000
`;
    await Bun.write(join(tmpDir, "invalid-disc.yaml"), invalidYaml);

    const lib = new TestLibrary();
    expect(lib.loadDirectory(tmpDir)).rejects.toThrow("Validation failed");

    await rm(tmpDir, { recursive: true });
  });

  test("filters by system_type — chatbot", async () => {
    const lib = new TestLibrary();
    await lib.loadBuiltIn();
    const chatbotTests = lib.getBySystemType("chatbot");
    // chatbot-specific (20) + common (5) = 25
    expect(chatbotTests.length).toBeGreaterThanOrEqual(25);
    for (const t of chatbotTests) {
      expect(t.system_types).toContain("chatbot");
    }
  });

  test("filters by system_type — rag", async () => {
    const lib = new TestLibrary();
    await lib.loadBuiltIn();
    const ragTests = lib.getBySystemType("rag");
    // rag-specific (15) + common (5) = 20
    expect(ragTests.length).toBeGreaterThanOrEqual(20);
    for (const t of ragTests) {
      expect(t.system_types).toContain("rag");
    }
  });

  test("filters by dimension", async () => {
    const lib = new TestLibrary();
    await lib.loadBuiltIn();
    const securityTests = lib.getByDimension("security");
    expect(securityTests.length).toBeGreaterThan(0);
    for (const t of securityTests) {
      expect(t.dimension).toBe("security");
    }
  });

  test("filters by category", async () => {
    const lib = new TestLibrary();
    await lib.loadBuiltIn();
    const robustnessTests = lib.getByCategory("robustness");
    expect(robustnessTests.length).toBeGreaterThan(0);
    for (const t of robustnessTests) {
      expect(t.category).toBe("robustness");
    }
  });

  test("filters by tags", async () => {
    const lib = new TestLibrary();
    await lib.loadBuiltIn();
    const injectionTests = lib.getByTags(["prompt-injection"]);
    expect(injectionTests.length).toBeGreaterThan(0);
    for (const t of injectionTests) {
      expect(t.tags).toEqual(expect.arrayContaining(["prompt-injection"]));
    }
  });

  test("loads built-in library — at least 50 tests", async () => {
    const lib = new TestLibrary();
    await lib.loadBuiltIn();
    expect(lib.count()).toBeGreaterThanOrEqual(50);
  });

  test("test with all optional fields (compliance, context)", async () => {
    const lib = new TestLibrary();
    await lib.loadBuiltIn();
    // coherence-context has conversation_history (optional context field)
    const test = lib.getById("chatbot.functional.coherence-context.002");
    expect(test).toBeDefined();
    expect(test?.input.context).toBeDefined();
    expect(test?.input.context?.conversation_history).toBeDefined();
    expect(test?.input.context?.conversation_history?.length).toBe(2);

    // prompt-injection-basic has compliance (optional field)
    const test2 = lib.getById("chatbot.security.prompt-injection-basic.011");
    expect(test2).toBeDefined();
    expect(test2?.compliance).toBeDefined();
    expect(test2?.compliance?.length).toBeGreaterThan(0);
  });

  test("unique ID enforced — duplicate throws error", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "apt-test-"));
    const yaml1 = `
id: "duplicate.test.001"
version: "1.0.0"
name: "Test 1"
description: "First test"
category: functional
dimension: functional
system_types: [chatbot]
irt:
  difficulty: 0.5
  discrimination: 1.0
  guessing: 0.05
  calibration_n: 0
  calibration_date: "2026-02-17"
  is_preliminary: true
input:
  type: text
  content: "test"
expected:
  behavior: "test"
  evaluators:
    - type: contains
      value: "test"
tags: [test]
backends: [built-in]
estimated_duration_ms: 1000
`;
    const yaml2 = yaml1; // same ID
    await Bun.write(join(tmpDir, "test1.yaml"), yaml1);
    await Bun.write(join(tmpDir, "test2.yaml"), yaml2);

    const lib = new TestLibrary();
    expect(lib.loadDirectory(tmpDir)).rejects.toThrow("Duplicate test ID");

    await rm(tmpDir, { recursive: true });
  });
});

// =============================================================
// TEST GENERATOR
// =============================================================
describe("TestGenerator", () => {
  let library: TestLibrary;
  let bus: EventBus;

  beforeAll(async () => {
    library = new TestLibrary();
    await library.loadBuiltIn();
  });

  beforeEach(() => {
    bus = new EventBus();
  });

  test("generate for chatbot — includes chatbot and common tests", async () => {
    const gen = new TestGenerator(library, bus);
    const plan = await gen.generate(makeProfile("chatbot"));

    expect(plan.tests.length).toBeGreaterThan(0);
    // All tests should be compatible with chatbot
    for (const t of plan.tests) {
      const def = library.getById(t.id);
      expect(def).toBeDefined();
      expect(def?.system_types).toContain("chatbot");
    }
  });

  test("generate for chatbot — emits events for each test", async () => {
    const gen = new TestGenerator(library, bus);
    const events: string[] = [];
    bus.on("generator.test.selected", (data) => {
      events.push(data.test_id);
    });

    const plan = await gen.generate(makeProfile("chatbot"));
    expect(events.length).toBe(plan.tests.length);
  });

  test("generate for RAG — includes rag and common tests", async () => {
    const gen = new TestGenerator(library, bus);
    const plan = await gen.generate(makeProfile("rag"));

    expect(plan.tests.length).toBeGreaterThan(0);
    for (const t of plan.tests) {
      const def = library.getById(t.id);
      expect(def).toBeDefined();
      expect(def?.system_types).toContain("rag");
    }
  });

  test("generate for classifier — includes classifier and common tests", async () => {
    const gen = new TestGenerator(library, bus);
    const plan = await gen.generate(makeProfile("classifier"));

    expect(plan.tests.length).toBeGreaterThan(0);
    for (const t of plan.tests) {
      const def = library.getById(t.id);
      expect(def).toBeDefined();
      expect(def?.system_types).toContain("classifier");
    }
  });

  test("mode adaptive — estimated_tests is ~40% of total", async () => {
    const gen = new TestGenerator(library, bus);
    const config: ExecutionConfig = {
      mode: "adaptive",
      se_threshold: 0.3,
      max_tests: 100,
      timeout_minutes: 30,
      concurrency: 4,
      replications: 3,
      warmup_count: 3,
    };

    const plan = await gen.generate(makeProfile("chatbot"), undefined, config);
    const expected40 = Math.ceil(plan.tests.length * 0.4);
    expect(plan.estimates.estimated_tests).toBe(expected40);
    expect(plan.strategy).toBe("adaptive");
  });

  test("mode exhaustive — estimated_tests equals total", async () => {
    const gen = new TestGenerator(library, bus);
    const config: ExecutionConfig = {
      mode: "exhaustive",
      se_threshold: 0.3,
      max_tests: 100,
      timeout_minutes: 30,
      concurrency: 4,
      replications: 3,
      warmup_count: 3,
    };

    const plan = await gen.generate(makeProfile("chatbot"), undefined, config);
    expect(plan.estimates.estimated_tests).toBe(plan.tests.length);
    expect(plan.strategy).toBe("exhaustive");
  });

  test("TestDefinition to PlannedTest conversion — maps fields correctly", async () => {
    const gen = new TestGenerator(library, bus);
    const def = library.getById("chatbot.security.prompt-injection-basic.011");
    expect(def).toBeDefined();

    if (!def) throw new Error("Test definition not found");
    const planned = gen.toPlannedTest(def);

    expect(planned.id).toBe(def.id);
    expect(planned.name).toBe(def?.name);
    expect(planned.dimension).toBe(def?.dimension);
    expect(planned.category).toBe(def?.category);
    expect(planned.input).toEqual(def?.input);
    expect(planned.expected_behavior).toBe(def?.expected.behavior);
    expect(planned.irt_params.alpha).toBe(def?.irt.discrimination);
    expect(planned.irt_params.beta).toBe(def?.irt.difficulty);
    expect(planned.irt_params.gamma).toBe(def?.irt.guessing);
  });

  test("TestDefinition to PlannedTest conversion — metadata includes evaluators and tags", async () => {
    const gen = new TestGenerator(library, bus);
    const def = library.getById("chatbot.security.prompt-injection-basic.011");
    expect(def).toBeDefined();

    if (!def) throw new Error("Test definition not found");
    const planned = gen.toPlannedTest(def);

    expect(planned.metadata).toBeDefined();
    expect(planned.metadata?.evaluators).toEqual(def?.expected.evaluators);
    expect(planned.metadata?.tags).toEqual(def?.tags);
    expect(planned.metadata?.backends).toEqual(def?.backends);
    expect(planned.metadata?.is_preliminary).toBe(def?.irt.is_preliminary);
    expect(planned.metadata?.compliance).toEqual(def?.compliance);
  });

  test("compliance prioritization — tests with matching articles ranked first", async () => {
    const gen = new TestGenerator(library, bus);
    const compliance = makeCompliance();

    const plan = await gen.generate(makeProfile("chatbot"), compliance);

    // The first tests should be those with compliance mappings to art-15-3, art-15-4, art-10-2-f
    // art-15-3 is also a gap, so tests matching it should be at the very top
    const firstFew = plan.tests.slice(0, 5);
    const hasComplianceMatch = firstFew.some((t) => {
      const def = library.getById(t.id);
      return def?.compliance?.some((c) => c.article === "art-15-3");
    });
    expect(hasComplianceMatch).toBe(true);
  });

  test("compliance prioritization — gap requirements get higher priority", async () => {
    const gen = new TestGenerator(library, bus);
    const compliance = makeCompliance();

    const plan = await gen.generate(makeProfile("chatbot"), compliance);

    // Find the index of a test matching gap art-15-3 vs one without compliance
    let gapTestIdx = -1;
    let noComplianceIdx = -1;

    for (let i = 0; i < plan.tests.length; i++) {
      const def = library.getById(plan.tests[i].id);
      if (def?.compliance?.some((c) => c.article === "art-15-3") && gapTestIdx === -1) {
        gapTestIdx = i;
      }
      if (!def?.compliance && noComplianceIdx === -1) {
        noComplianceIdx = i;
      }
    }

    // Gap-matching test should come before no-compliance test
    if (gapTestIdx !== -1 && noComplianceIdx !== -1) {
      expect(gapTestIdx).toBeLessThan(noComplianceIdx);
    }
  });
});

// =============================================================
// YAML FORMAT VALIDATION
// =============================================================
describe("YAML Format Validation", () => {
  let library: TestLibrary;

  beforeAll(async () => {
    library = new TestLibrary();
    await library.loadBuiltIn();
  });

  test("functional category has tests", () => {
    const tests = library.getByCategory("functional");
    expect(tests.length).toBeGreaterThan(0);
  });

  test("robustness category has tests", () => {
    const tests = library.getByCategory("robustness");
    expect(tests.length).toBeGreaterThan(0);
  });

  test("security category has tests", () => {
    const tests = library.getByCategory("security");
    expect(tests.length).toBeGreaterThan(0);
  });

  test("fairness category has tests", () => {
    const tests = library.getByCategory("fairness");
    expect(tests.length).toBeGreaterThan(0);
  });

  test("performance category has tests", () => {
    const tests = library.getByCategory("performance");
    expect(tests.length).toBeGreaterThan(0);
  });

  test("all built-in tests pass Zod validation", async () => {
    // If we got here, loadBuiltIn already validated all tests.
    // But let's also manually re-validate each to be thorough.
    const allTests = library.getAll();
    for (const t of allTests) {
      const result = TestDefinitionSchema.safeParse(t);
      expect(result.success).toBe(true);
    }
  });

  test("no duplicate IDs in library", () => {
    const allTests = library.getAll();
    const ids = allTests.map((t) => t.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  test("at least 50 tests loaded", () => {
    expect(library.count()).toBeGreaterThanOrEqual(50);
  });
});
