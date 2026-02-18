import { loadConfig } from "@apt/lib/config";
import { DETECTION_CONFIDENCE_THRESHOLD, EXIT_CODES } from "@apt/lib/types";
import type { SystemProfile, TargetConfig } from "@apt/lib/types";
import { HttpAdapter } from "@apt/modules/introspector/adapters/http";
import { defineCommand } from "citty";
import { consola } from "consola";

export default defineCommand({
  meta: {
    name: "introspect",
    version: "0.0.1",
    description: "Introspect a target AI system",
  },
  args: {
    target: {
      type: "string",
      description: "Target system URL",
    },
    output: {
      type: "string",
      description: "Output file for profile JSON",
    },
  },
  async run({ args }) {
    let targetConfig: TargetConfig;

    if (args.target) {
      targetConfig = {
        url: args.target,
        adapter: "http",
        timeout_ms: 30000,
        system_type: "auto",
      };
    } else {
      try {
        const config = await loadConfig();
        targetConfig = config.target;
      } catch {
        consola.error("No target specified. Use --target <url> or create apt.config.yaml");
        process.exit(EXIT_CODES.ERROR);
      }
    }

    consola.start(`Introspecting ${targetConfig.url}...`);

    const adapter = new HttpAdapter();

    try {
      await adapter.connect(targetConfig);
      consola.success("Connection established");

      const metadata = await adapter.inspect();
      consola.info("Metadata:", metadata);

      // Build a basic system profile
      const profile: SystemProfile = {
        id: crypto.randomUUID(),
        detected_at: new Date().toISOString(),
        system_type: (targetConfig.system_type === "auto"
          ? "chatbot"
          : targetConfig.system_type) as SystemProfile["system_type"],
        detection_confidence: metadata.detected_provider ? 0.8 : 0.5,
        detection_methods: [
          {
            method: "http-probe",
            confidence: metadata.detected_provider ? 0.8 : 0.5,
            evidence: metadata as unknown as Record<string, unknown>,
          },
        ],
        input_interfaces: [{ type: "text", format: "json" }],
        output_interfaces: [{ type: "text", format: metadata.response_format ?? "text" }],
        capabilities: [],
        dependencies: metadata.detected_provider ? [{ provider: metadata.detected_provider }] : [],
        adapter: targetConfig,
      };

      // Confidence check
      if (profile.detection_confidence < DETECTION_CONFIDENCE_THRESHOLD) {
        consola.warn(
          `Low detection confidence (${profile.detection_confidence}). Consider specifying system_type in config.`,
        );
      }

      // Output
      if (args.output) {
        await Bun.write(args.output, JSON.stringify(profile, null, 2));
        consola.success(`Profile saved to ${args.output}`);
      } else {
        consola.box(JSON.stringify(profile, null, 2));
      }

      await adapter.disconnect();
      process.exit(EXIT_CODES.PASS);
    } catch (error) {
      const err = error as Error;
      consola.error(`Introspection failed: ${err.message}`);
      await adapter.disconnect();
      process.exit(EXIT_CODES.ERROR);
    }
  },
});
