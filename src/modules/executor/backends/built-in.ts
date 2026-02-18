import type {
  ExecutionBackend,
  PlannedTest,
  SystemAdapter,
  TestCategory,
  TestEvaluator,
  TestResult,
} from "@apt/lib/types";

/** Strip markdown code fences (```json ... ```) so regex can match raw content */
function stripCodeFences(content: string): string {
  return content
    .replace(/^```[\w]*\n?/gm, "")
    .replace(/^```\s*$/gm, "")
    .trim();
}

export class BuiltInBackend implements ExecutionBackend {
  id = "built-in";
  name = "APT Built-in Evaluator";
  supported_categories: TestCategory[] = [
    "functional",
    "robustness",
    "security",
    "fairness",
    "performance",
    "compliance",
  ];
  capabilities = {
    supports_replications: true,
    supports_streaming: false,
    supports_multimodal: false,
    supports_multi_turn: false,
  };

  async healthcheck() {
    return { available: true, version: "1.0.0" };
  }

  async execute(test: PlannedTest, adapter: SystemAdapter): Promise<TestResult> {
    const start = performance.now();

    // 1. Send the input via the adapter
    const output = await adapter.send(test.input);
    const duration_ms = performance.now() - start;

    // 2. Evaluate response with evaluators from test.metadata
    const evaluators = (test.metadata?.evaluators as TestEvaluator[]) ?? [];
    const evalResults = evaluators.map((ev) => this.evaluate(output.content, ev));

    // 3. Score = proportion of evaluators passed
    const passed = evalResults.length > 0 ? evalResults.every((r) => r.passed) : false;
    const score =
      evalResults.length > 0 ? evalResults.filter((r) => r.passed).length / evalResults.length : 0;

    return {
      test_id: test.id,
      backend_id: this.id,
      passed,
      score,
      metrics: {
        latency_ms: output.latency_ms,
        evaluators_passed: evalResults.filter((r) => r.passed).length,
        evaluators_total: evalResults.length,
      },
      raw_output: output.content,
      duration_ms,
      metadata: { evaluator_results: evalResults },
    };
  }

  private evaluate(content: string, evaluator: TestEvaluator): { passed: boolean; detail: string } {
    switch (evaluator.type) {
      case "contains":
        return {
          passed: evaluator.value
            ? content.toLowerCase().includes(evaluator.value.toLowerCase())
            : content.length > 0,
          detail: `contains "${evaluator.value}"`,
        };
      case "not_contains":
        return {
          passed:
            !evaluator.value || !content.toLowerCase().includes(evaluator.value.toLowerCase()),
          detail: `not_contains "${evaluator.value}"`,
        };
      case "regex": {
        const stripped = stripCodeFences(content);
        return {
          passed: evaluator.value ? new RegExp(evaluator.value, "is").test(stripped) : false,
          detail: `regex "${evaluator.value}"`,
        };
      }
      case "not_regex": {
        const strippedNr = stripCodeFences(content);
        return {
          passed: evaluator.value ? !new RegExp(evaluator.value, "is").test(strippedNr) : true,
          detail: `not_regex "${evaluator.value}"`,
        };
      }
      case "score_threshold": {
        const contentScore = content.trim().length > 0 ? 1 : 0;
        return {
          passed: contentScore >= (evaluator.threshold ?? 0.5),
          detail: `score_threshold ${evaluator.threshold}`,
        };
      }
      case "llm-judge":
        // Phase 1: fallback to heuristic (length + basic relevance)
        return {
          passed: content.trim().length > 10,
          detail: "llm-judge (heuristic fallback)",
        };
    }
  }
}
