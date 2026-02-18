import type {
  DetectionContext,
  DetectionResult,
  Detector,
  SystemOutput,
  SystemType,
  TargetConfig,
} from "@apt/lib/types";

interface ProbeResult {
  output: SystemOutput;
  latency_ms: number;
}

export class IOProbingDetector implements Detector {
  name = "io-probing";
  priority = 20;

  async detect(_target: TargetConfig, context: DetectionContext): Promise<DetectionResult> {
    const evidence: Record<string, unknown> = {};
    const scores: Record<SystemType, number> = {
      chatbot: 0,
      rag: 0,
      classifier: 0,
      agent: 0,
      pipeline: 0,
      vision: 0,
      audio: 0,
      embedding: 0,
      custom: 0,
    };

    const adapter = context.adapter;
    if (!adapter) {
      return { system_type: null, confidence: 0, evidence: { error: "no adapter available" } };
    }

    // Probe 1: Conversational check
    try {
      const probe1 = await this.sendProbe(adapter, "Hello, how are you?");
      evidence.probe_conversational = {
        response_length: probe1.output.content.length,
        latency_ms: probe1.latency_ms,
      };
      const content = probe1.output.content.toLowerCase();
      // Conversational indicators
      if (
        content.length > 20 &&
        (content.includes("hello") ||
          content.includes("hi") ||
          content.includes("how") ||
          content.includes("help") ||
          content.includes("assist") ||
          content.includes("good") ||
          content.includes("fine") ||
          content.includes("great"))
      ) {
        scores.chatbot += 0.3;
        evidence.conversational_response = true;
      }
    } catch (err) {
      evidence.probe1_error = (err as Error).message;
    }

    // Probe 2: RAG check — ask for sources
    try {
      const probe2 = await this.sendProbe(
        adapter,
        "What is the capital of France? Cite your sources.",
      );
      evidence.probe_rag = {
        response_length: probe2.output.content.length,
        latency_ms: probe2.latency_ms,
      };
      const content = probe2.output.content.toLowerCase();
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(probe2.output.content);
      } catch {
        // not JSON
      }

      if (parsed && ("sources" in parsed || "documents" in parsed || "references" in parsed)) {
        scores.rag += 0.5;
        evidence.rag_structured_sources = true;
      } else if (
        content.includes("source") ||
        content.includes("reference") ||
        content.includes("[1]") ||
        content.includes("citation")
      ) {
        scores.rag += 0.3;
        evidence.rag_text_sources = true;
      }
    } catch (err) {
      evidence.probe2_error = (err as Error).message;
    }

    // Probe 3: Classification check
    try {
      const probe3 = await this.sendProbe(adapter, "Classify this text: 'Great product!'");
      evidence.probe_classifier = {
        response_length: probe3.output.content.length,
        latency_ms: probe3.latency_ms,
      };

      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(probe3.output.content);
      } catch {
        // not JSON
      }

      if (parsed && ("label" in parsed || "class" in parsed || "prediction" in parsed)) {
        scores.classifier += 0.5;
        evidence.classifier_structured = true;
      } else {
        const content = probe3.output.content.toLowerCase();
        if (
          (content.includes("positive") ||
            content.includes("negative") ||
            content.includes("neutral")) &&
          content.length < 100
        ) {
          scores.classifier += 0.3;
          evidence.classifier_text_label = true;
        }
      }
    } catch (err) {
      evidence.probe3_error = (err as Error).message;
    }

    // Probe 4: Agent/multi-step check
    try {
      const probe4 = await this.sendProbe(adapter, "Search for X then summarize the results");
      evidence.probe_agent = {
        response_length: probe4.output.content.length,
        latency_ms: probe4.latency_ms,
      };

      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(probe4.output.content);
      } catch {
        // not JSON
      }

      if (parsed && ("actions" in parsed || "tools" in parsed || "steps" in parsed)) {
        scores.agent += 0.5;
        evidence.agent_structured = true;
      } else {
        const content = probe4.output.content.toLowerCase();
        if (
          content.includes("step") ||
          content.includes("action") ||
          content.includes("tool") ||
          content.includes("searching")
        ) {
          scores.agent += 0.2;
          evidence.agent_text_hint = true;
        }
      }
    } catch (err) {
      evidence.probe4_error = (err as Error).message;
    }

    // Probe 5: Determinism check — send same request 3x
    try {
      const responses: string[] = [];
      for (let i = 0; i < 3; i++) {
        const probe = await this.sendProbe(adapter, "What is 2 + 2?");
        responses.push(probe.output.content);
      }

      const uniqueResponses = new Set(responses);
      const determinism = 1 - (uniqueResponses.size - 1) / (responses.length - 1);
      evidence.determinism = determinism;
      evidence.unique_responses = uniqueResponses.size;

      // High determinism suggests classifier or embedding
      if (determinism >= 0.9) {
        scores.classifier += 0.3;
        evidence.high_determinism = true;
      }
    } catch (err) {
      evidence.probe5_error = (err as Error).message;
    }

    // Find the best scoring system type
    let bestType: SystemType | null = null;
    let bestScore = 0;
    for (const [type, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        bestType = type as SystemType;
      }
    }

    // Calculate confidence from scores
    const totalScore = Object.values(scores).reduce((sum, s) => sum + s, 0);
    const confidence =
      totalScore > 0 ? Math.min(bestScore / Math.max(totalScore, 1) + bestScore * 0.5, 0.95) : 0;

    evidence.scores = scores;

    return {
      system_type: bestType && bestScore > 0 ? bestType : null,
      confidence: Math.round(confidence * 100) / 100,
      evidence,
    };
  }

  private async sendProbe(
    adapter: { send: (input: { type: "text"; content: string }) => Promise<SystemOutput> },
    content: string,
  ): Promise<ProbeResult> {
    const start = performance.now();
    const output = await adapter.send({ type: "text", content });
    const latency = performance.now() - start;
    return { output, latency_ms: Math.round(latency) };
  }
}
