import { writeConfig } from "@apt/lib/config";
import { AptConfigSchema } from "@apt/lib/schema";
import { defineCommand } from "citty";
import { consola } from "consola";

export default defineCommand({
  meta: {
    name: "init",
    version: "0.0.1",
    description: "Initialize a new APT evaluation project",
  },
  args: {
    target: {
      type: "string",
      description: "Target system URL",
    },
    adapter: {
      type: "string",
      description: "Adapter type (http, cli, sdk-openai, sdk-anthropic, docker)",
      default: "http",
    },
    model: {
      type: "string",
      description: "Model name (e.g. gpt-4, qwen2.5-coder:7b-instruct)",
    },
    auth: {
      type: "string",
      description: "Auth type (bearer, api-key, basic, none)",
      default: "none",
    },
  },
  async run({ args }) {
    let url = args.target;

    // Interactive mode if no target provided and TTY
    if (!url && process.stdin.isTTY) {
      url = (await consola.prompt("Target system URL:", {
        type: "text",
      })) as string;
      if (!url) {
        consola.error("Target URL is required");
        process.exit(2);
      }
    }

    if (!url) {
      consola.error("Target URL is required. Use --target <url>");
      process.exit(2);
    }

    const config = {
      version: "1",
      target: {
        url,
        adapter: args.adapter as "http" | "cli" | "sdk-openai" | "sdk-anthropic" | "docker",
        ...(args.model ? { model: args.model } : {}),
        ...(args.auth !== "none"
          ? {
              auth: {
                type: args.auth as "bearer" | "api-key" | "basic" | "none",
              },
            }
          : {}),
        timeout_ms: 30000,
        system_type: "auto" as const,
      },
      execution: {
        mode: "adaptive" as const,
        se_threshold: 0.3,
        max_tests: 100,
        timeout_minutes: 30,
        concurrency: 4,
        replications: 3,
        warmup_count: 3,
      },
      analysis: {
        confidence_level: 0.95,
        drift_detection: true,
        effect_size_threshold: 0.5,
        power_target: 0.8,
      },
      reports: {
        formats: ["json", "html"],
        output_dir: "./apt-reports",
        include_raw_data: false,
      },
      storage: {
        database: "apt.db",
        retention_days: 90,
      },
      backends: {
        enabled: ["custom"],
      },
      plugins: {
        detectors: [] as string[],
        backends: [] as string[],
      },
    };

    // Validate the config
    const result = AptConfigSchema.safeParse(config);
    if (!result.success) {
      consola.error("Invalid configuration:", result.error.issues);
      process.exit(2);
    }

    const outputPath = "apt.config.yaml";
    await writeConfig(config, outputPath);
    consola.success(`Config written to ${outputPath}`);
    consola.info("Run `apt run` to start evaluation.");
  },
});
