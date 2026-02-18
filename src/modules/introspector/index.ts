import type { EventBus } from "@apt/core/event-bus";
import type {
  DetectionContext,
  DetectionResult,
  Detector,
  SystemAdapter,
  SystemProfile,
  SystemType,
  TargetConfig,
} from "@apt/lib/types";

export class Introspector {
  constructor(
    private detectors: Detector[],
    private adapter: SystemAdapter,
    private bus: EventBus,
  ) {}

  async profile(target: TargetConfig): Promise<SystemProfile> {
    this.bus.emit("introspector.started", { target });

    // 1. If system_type is explicitly set (not "auto"), return immediately
    if (target.system_type && target.system_type !== "auto") {
      const profile = this.buildProfile(target, target.system_type as SystemType, 1.0, []);
      this.bus.emit("introspector.completed", { profile });
      return profile;
    }

    // 2. Run detectors in priority order (ASC)
    const sortedDetectors = [...this.detectors].sort((a, b) => a.priority - b.priority);
    const results: DetectionResult[] = [];
    const methods: SystemProfile["detection_methods"] = [];

    for (const detector of sortedDetectors) {
      const context: DetectionContext = {
        target,
        partialResults: [...results],
        adapter: this.adapter,
      };

      try {
        const result = await detector.detect(target, context);
        results.push(result);
        methods.push({
          method: detector.name,
          confidence: result.confidence,
          evidence: result.evidence,
        });
      } catch (err) {
        // Emit warning, continue with remaining detectors
        this.bus.emit("pipeline.failed", {
          error: {
            module: `introspector.detector.${detector.name}`,
            severity: "warning",
            code: "INTRO_DET_WARN",
            message: `Detector ${detector.name} failed: ${(err as Error).message}`,
            recoverable: true,
          },
        });
      }
    }

    // 3. Fuse results: weighted vote by confidence
    const { systemType, confidence } = this.fuseResults(results);

    // 4. Collect baseline
    const baseline = await this.collectBaseline();

    // 5. Build and return SystemProfile
    const profile = this.buildProfile(target, systemType, confidence, methods, baseline);
    this.bus.emit("introspector.completed", { profile });
    return profile;
  }

  private fuseResults(results: DetectionResult[]): {
    systemType: SystemType;
    confidence: number;
  } {
    // Filter out null results
    const validResults = results.filter(
      (r): r is DetectionResult & { system_type: SystemType } =>
        r.system_type !== null && r.confidence > 0,
    );

    if (validResults.length === 0) {
      // No results -> default "chatbot" with confidence 0.5
      return { systemType: "chatbot", confidence: 0.5 };
    }

    // Count votes per type, weighted by confidence
    const votes: Record<string, { totalConfidence: number; maxConfidence: number; count: number }> =
      {};
    for (const result of validResults) {
      if (!votes[result.system_type]) {
        votes[result.system_type] = { totalConfidence: 0, maxConfidence: 0, count: 0 };
      }
      votes[result.system_type].totalConfidence += result.confidence;
      votes[result.system_type].maxConfidence = Math.max(
        votes[result.system_type].maxConfidence,
        result.confidence,
      );
      votes[result.system_type].count++;
    }

    // Sort types by total confidence (descending)
    const sorted = Object.entries(votes).sort(
      (a, b) => b[1].totalConfidence - a[1].totalConfidence,
    );

    const topType = sorted[0][0] as SystemType;

    // Check unanimity
    const allTypes = new Set(validResults.map((r) => r.system_type));
    let finalConfidence: number;

    if (allTypes.size === 1) {
      // Unanimous -> confidence = max of all confidences
      finalConfidence = Math.max(...validResults.map((r) => r.confidence));
    } else {
      // Conflict -> confidence = diff between top2 weighted scores
      const top1Score = sorted[0][1].totalConfidence;
      const top2Score = sorted.length > 1 ? sorted[1][1].totalConfidence : 0;
      finalConfidence = Math.min((top1Score - top2Score) / Math.max(top1Score, 1), 0.95);
      // Ensure at least some confidence if top type has votes
      finalConfidence = Math.max(finalConfidence, 0.1);
    }

    return {
      systemType: topType,
      confidence: Math.round(finalConfidence * 100) / 100,
    };
  }

  private async collectBaseline(): Promise<SystemProfile["baseline_metrics"]> {
    const latencies: number[] = [];
    const responses: string[] = [];
    const baselineInput = { type: "text" as const, content: "Hello" };

    try {
      // Warmup: 10 requests (discard)
      for (let i = 0; i < 10; i++) {
        this.bus.emit("introspector.baseline.progress", {
          current: i + 1,
          total: 10,
          phase: "warmup",
        });
        try {
          await this.adapter.send(baselineInput);
        } catch {
          // Warmup failures are acceptable
        }
      }

      // Measurement: 20 requests
      for (let i = 0; i < 20; i++) {
        this.bus.emit("introspector.baseline.progress", {
          current: i + 1,
          total: 20,
          phase: "measure",
        });
        try {
          const start = performance.now();
          const output = await this.adapter.send(baselineInput);
          const latency = performance.now() - start;
          latencies.push(latency);
          responses.push(output.content);
        } catch {
          // measurement failure, skip
        }
      }
    } catch {
      // Baseline collection failed entirely
    }

    if (latencies.length === 0) {
      return undefined;
    }

    // Sort latencies for percentile calculation
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = this.percentile(sorted, 50);
    const p95 = this.percentile(sorted, 95);
    const p99 = this.percentile(sorted, 99);

    // Measure determinism: ratio of identical responses
    const uniqueResponses = new Set(responses);
    const determinism =
      responses.length > 0 ? 1 - (uniqueResponses.size - 1) / Math.max(responses.length - 1, 1) : 0;

    return {
      latency_p50: Math.round(p50 * 100) / 100,
      latency_p95: Math.round(p95 * 100) / 100,
      latency_p99: Math.round(p99 * 100) / 100,
      determinism: Math.round(determinism * 100) / 100,
      format: "text",
    };
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0];
    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sorted[lower];
    const weight = index - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  }

  private buildProfile(
    target: TargetConfig,
    systemType: SystemType,
    confidence: number,
    methods: SystemProfile["detection_methods"],
    baseline?: SystemProfile["baseline_metrics"],
  ): SystemProfile {
    return {
      id: `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      detected_at: new Date().toISOString(),
      system_type: systemType,
      detection_confidence: confidence,
      detection_methods: methods,
      input_interfaces: [
        {
          type: "text",
          format: "json",
        },
      ],
      output_interfaces: [
        {
          type: "text",
          format: baseline?.format ?? "text",
          latency: baseline?.latency_p50,
        },
      ],
      capabilities: [systemType],
      dependencies: [],
      adapter: target,
      baseline_metrics: baseline,
    };
  }
}

export { EndpointDetector } from "@apt/modules/introspector/detectors/endpoint";
export { IOProbingDetector } from "@apt/modules/introspector/detectors/io-probing";
export { ConfigFileDetector } from "@apt/modules/introspector/detectors/config-file";
export { DependencyDetector } from "@apt/modules/introspector/detectors/dependency";
