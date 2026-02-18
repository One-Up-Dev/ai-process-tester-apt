import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configToPipelineConfig, loadConfig, writeConfig } from "@apt/lib/config";
import { AptConfigSchema, ExecutionConfigSchema, TargetConfigSchema } from "@apt/lib/schema";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "apt-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("Zod schema validation", () => {
  // 1. Valid complete config passes Zod
  test("valid complete config passes validation", () => {
    const config = {
      version: "1",
      target: {
        url: "http://localhost:3000",
        adapter: "http",
        auth: { type: "bearer", token: "abc123" },
        timeout_ms: 30000,
        system_type: "chatbot",
      },
      compliance: {
        jurisdiction: "EU",
        risk_classification: "high-risk",
        sector: "finance",
        standards: ["eu-ai-act"],
        exclusions: [],
      },
      execution: {
        mode: "adaptive",
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
        detectors: [],
        backends: [],
      },
    };

    const result = AptConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  // 2. Minimal config with defaults passes
  test("minimal config with only target passes with defaults", () => {
    const config = {
      target: {
        url: "http://localhost:3000",
      },
    };

    const result = AptConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe("1");
      expect(result.data.target.adapter).toBe("http");
      expect(result.data.target.timeout_ms).toBe(120000);
      expect(result.data.target.system_type).toBe("auto");
      expect(result.data.execution.mode).toBe("adaptive");
    }
  });

  // 3. Missing required url -> error
  test("missing required url produces error", () => {
    const config = {
      target: {
        adapter: "http",
      },
    };

    const result = AptConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const urlIssue = result.error.issues.find((i) => i.path.includes("url"));
      expect(urlIssue).toBeDefined();
    }
  });

  // 4. Invalid enum (adapter: "ftp") -> error
  test('invalid adapter type "ftp" produces error', () => {
    const result = TargetConfigSchema.safeParse({
      url: "http://localhost:3000",
      adapter: "ftp",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const adapterIssue = result.error.issues.find((i) => i.path.includes("adapter"));
      expect(adapterIssue).toBeDefined();
    }
  });

  // 5. Invalid enum (mode: "random") -> error
  test('invalid execution mode "random" produces error', () => {
    const result = ExecutionConfigSchema.safeParse({
      mode: "random",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const modeIssue = result.error.issues.find((i) => i.path.includes("mode"));
      expect(modeIssue).toBeDefined();
    }
  });

  // 6. Defaults applied (mode=adaptive, se_threshold=0.3, etc.)
  test("execution defaults are applied correctly", () => {
    const result = ExecutionConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe("adaptive");
      expect(result.data.se_threshold).toBe(0.3);
      expect(result.data.max_tests).toBe(100);
      expect(result.data.timeout_minutes).toBe(30);
      expect(result.data.concurrency).toBe(4);
      expect(result.data.replications).toBe(3);
      expect(result.data.warmup_count).toBe(3);
    }
  });

  // 7. Defaults applied for optional sections (reports, storage, etc.)
  test("optional section defaults are applied correctly", () => {
    const config = {
      target: { url: "http://localhost:3000" },
    };
    const result = AptConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      // Reports defaults
      expect(result.data.reports.formats).toEqual(["json", "html"]);
      expect(result.data.reports.output_dir).toBe("./apt-reports");
      expect(result.data.reports.include_raw_data).toBe(false);
      // Storage defaults
      expect(result.data.storage.database).toBe("apt.db");
      expect(result.data.storage.retention_days).toBe(90);
      // Backends defaults
      expect(result.data.backends.enabled).toEqual(["custom"]);
      // Plugins defaults
      expect(result.data.plugins.detectors).toEqual([]);
      expect(result.data.plugins.backends).toEqual([]);
      // Analysis defaults
      expect(result.data.analysis.confidence_level).toBe(0.95);
      expect(result.data.analysis.drift_detection).toBe(true);
    }
  });
});

describe("Env var interpolation", () => {
  // 8. Env var interpolation ${TOKEN} -> value
  test("interpolates ${TOKEN} in auth token via loadConfig", async () => {
    const originalToken = Bun.env.TEST_APT_TOKEN;
    process.env.TEST_APT_TOKEN = "secret-value-123";

    const configPath = join(tmpDir, "apt.config.yaml");
    await Bun.write(
      configPath,
      `
version: "1"
target:
  url: "http://localhost:3000"
  auth:
    type: bearer
    token: "\${TEST_APT_TOKEN}"
`,
    );

    const config = await loadConfig(configPath);
    expect(config.target.auth?.token).toBe("secret-value-123");

    if (originalToken !== undefined) {
      process.env.TEST_APT_TOKEN = originalToken;
    } else {
      process.env.TEST_APT_TOKEN = undefined;
    }
  });

  // 9. Env var interpolation in target.url
  test("interpolates ${HOST} in target.url via loadConfig", async () => {
    const originalHost = Bun.env.TEST_APT_HOST;
    process.env.TEST_APT_HOST = "my-api.example.com";

    const configPath = join(tmpDir, "apt.config.yaml");
    await Bun.write(
      configPath,
      `
version: "1"
target:
  url: "http://\${TEST_APT_HOST}:8080"
`,
    );

    const config = await loadConfig(configPath);
    expect(config.target.url).toBe("http://my-api.example.com:8080");

    if (originalHost !== undefined) {
      process.env.TEST_APT_HOST = originalHost;
    } else {
      process.env.TEST_APT_HOST = undefined;
    }
  });
});

describe("loadConfig", () => {
  // 10. loadConfig with valid YAML file
  test("loads and validates a valid YAML config file", async () => {
    const configPath = join(tmpDir, "apt.config.yaml");
    await Bun.write(
      configPath,
      `
version: "1"
target:
  url: "http://localhost:3000"
  adapter: http
  timeout_ms: 15000
  system_type: chatbot
execution:
  mode: exhaustive
  max_tests: 200
`,
    );

    const config = await loadConfig(configPath);
    expect(config.target.url).toBe("http://localhost:3000");
    expect(config.target.adapter).toBe("http");
    expect(config.target.timeout_ms).toBe(15000);
    expect(config.target.system_type).toBe("chatbot");
    expect(config.execution.mode).toBe("exhaustive");
    expect(config.execution.max_tests).toBe(200);
    // Defaults should still be applied for missing fields
    expect(config.execution.se_threshold).toBe(0.3);
  });

  // 11. loadConfig with invalid YAML throws with CONF_INV_001
  test("throws CONF_INV_001 for invalid config content", async () => {
    const configPath = join(tmpDir, "apt.config.yaml");
    await Bun.write(
      configPath,
      `
version: "1"
target:
  url: "not-a-valid-url"
  adapter: "ftp"
`,
    );

    try {
      await loadConfig(configPath);
      expect(true).toBe(false); // Should not reach here
    } catch (error: unknown) {
      const err = error as { moduleError?: { code: string; message: string } };
      expect(err.moduleError?.code).toBe("CONF_INV_001");
      expect(err.moduleError?.message).toContain("Invalid config");
    }
  });

  // 12. loadConfig throws CONF_NF_002 for non-existent file
  test("throws CONF_NF_002 for non-existent config file", async () => {
    const fakePath = join(tmpDir, "nonexistent.yaml");

    try {
      await loadConfig(fakePath);
      expect(true).toBe(false); // Should not reach here
    } catch (error: unknown) {
      const err = error as { moduleError?: { code: string } };
      expect(err.moduleError?.code).toBe("CONF_NF_002");
    }
  });
});

describe("configToPipelineConfig", () => {
  // 13. configToPipelineConfig mapping correct
  test("maps AptConfig to PipelineConfig correctly", () => {
    const aptConfig = AptConfigSchema.parse({
      target: { url: "http://localhost:3000" },
      compliance: {
        jurisdiction: "EU",
        risk_classification: "high-risk",
        sector: "general",
        standards: ["eu-ai-act"],
      },
    });

    const pipeline = configToPipelineConfig(aptConfig);

    expect(pipeline.target).toEqual(aptConfig.target);
    expect(pipeline.compliance).toEqual(aptConfig.compliance);
    expect(pipeline.execution).toEqual(aptConfig.execution);
    expect(pipeline.analysis).toEqual(aptConfig.analysis);
    expect(pipeline.reports).toEqual(aptConfig.reports);
    // Storage, backends, plugins, integrations should NOT be in pipeline
    expect((pipeline as unknown as Record<string, unknown>).storage).toBeUndefined();
    expect((pipeline as unknown as Record<string, unknown>).backends).toBeUndefined();
    expect((pipeline as unknown as Record<string, unknown>).plugins).toBeUndefined();
  });
});

describe("writeConfig", () => {
  // 14. writeConfig creates valid YAML
  test("writes config that can be loaded back", async () => {
    const config = {
      version: "1",
      target: {
        url: "http://localhost:4000",
        adapter: "http" as const,
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
    };

    const configPath = join(tmpDir, "apt.config.yaml");
    await writeConfig(config, configPath);

    // Verify the file exists and can be loaded
    const loaded = await loadConfig(configPath);
    expect(loaded.target.url).toBe("http://localhost:4000");
    expect(loaded.execution.mode).toBe("adaptive");
  });
});
