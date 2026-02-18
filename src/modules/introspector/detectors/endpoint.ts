import type {
  DetectionContext,
  DetectionResult,
  Detector,
  SystemType,
  TargetConfig,
} from "@apt/lib/types";

export class EndpointDetector implements Detector {
  name = "endpoint";
  priority = 10;

  async detect(_target: TargetConfig, context: DetectionContext): Promise<DetectionResult> {
    const evidence: Record<string, unknown> = {};
    let systemType: SystemType | null = null;
    let confidence = 0;

    const adapter = context.adapter;
    if (!adapter) {
      return { system_type: null, confidence: 0, evidence: { error: "no adapter available" } };
    }

    // 1. Probe OPTIONS -> check headers
    try {
      const metadata = await adapter.inspect();
      evidence.metadata = metadata;

      if (metadata.headers) {
        const headerKeys = Object.keys(metadata.headers).map((k) => k.toLowerCase());
        if (
          headerKeys.some((k) => ["x-model", "x-provider", "x-openai", "x-anthropic"].includes(k))
        ) {
          systemType = "chatbot";
          confidence = 0.7;
          evidence.headers_hint = "AI provider headers detected";
        }
      }

      // Check if OpenAI-compatible via /models
      if (metadata.detected_provider === "openai-compatible") {
        systemType = "chatbot";
        confidence = 0.9;
        evidence.openai_compatible = true;
      }
    } catch {
      evidence.options_error = "OPTIONS/inspect probe failed";
    }

    // 2. POST test input -> analyze response structure
    try {
      const start = performance.now();
      const output = await adapter.send({
        type: "text",
        content: "Hello",
      });
      const latency = performance.now() - start;
      evidence.latency_ms = Math.round(latency);
      evidence.response_format = output.format;

      // Try to parse response content as JSON for structure analysis
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(output.content);
      } catch {
        // Response is plain text, not JSON — that's fine
      }

      if (parsed) {
        // response.choices -> chatbot OpenAI-compat
        if ("choices" in parsed && Array.isArray(parsed.choices)) {
          systemType = "chatbot";
          confidence = Math.max(confidence, 0.9);
          evidence.openai_choices = true;
        }

        // response.sources or .documents -> RAG
        if ("sources" in parsed || "documents" in parsed) {
          systemType = "rag";
          confidence = Math.max(confidence, 0.85);
          evidence.rag_sources = true;
        }

        // response.label/.class/.prediction -> classifier
        if ("label" in parsed || "class" in parsed || "prediction" in parsed) {
          systemType = "classifier";
          confidence = Math.max(confidence, 0.85);
          evidence.classifier_output = true;
        }

        // response.actions/.tools/.steps -> agent
        if ("actions" in parsed || "tools" in parsed || "steps" in parsed) {
          systemType = "agent";
          confidence = Math.max(confidence, 0.8);
          evidence.agent_actions = true;
        }
      }

      // Check Content-Type from metadata for image
      const outputMeta = output.metadata as Record<string, unknown> | undefined;
      if (outputMeta) {
        const headers = outputMeta.headers as Record<string, string> | undefined;
        if (headers) {
          const contentType = headers["content-type"] || headers["Content-Type"] || "";
          if (contentType.startsWith("image/")) {
            systemType = "vision";
            confidence = Math.max(confidence, 0.9);
            evidence.vision_content_type = contentType;
          }
        }
      }

      // Analyze latency: < 50ms -> embedding probable
      if (latency < 50 && !systemType) {
        systemType = "embedding";
        confidence = Math.max(confidence, 0.85);
        evidence.fast_latency_hint = "embedding";
      }
    } catch (err) {
      evidence.send_error = (err as Error).message;
    }

    return { system_type: systemType, confidence, evidence };
  }
}
