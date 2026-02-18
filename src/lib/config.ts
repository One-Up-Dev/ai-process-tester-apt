import { createModuleError } from "@apt/core/errors";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { type AptConfig, AptConfigSchema } from "./schema";
import type { PipelineConfig } from "./types";

/** Find config file walking up directories */
function findConfigFile(startDir?: string): string | null {
  const names = ["apt.config.yaml", "apt.config.yml"];
  let dir = startDir ?? process.cwd();

  for (let i = 0; i < 10; i++) {
    for (const name of names) {
      const path = `${dir}/${name}`;
      const _file = Bun.file(path);
      // Bun.file().size returns 0 for non-existent files
      // We need to check existence more reliably
      try {
        const stat = Bun.file(path);
        // stat.size is 0 for non-existent; we check synchronously
        if (stat.size > 0) return path;
      } catch {
        // file not found, continue
      }
    }
    const parent = dir.replace(/\/[^/]+$/, "");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Interpolate ${VAR} with Bun.env */
function interpolateEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{(\w+)\}/g, (_, varName) => Bun.env[varName] ?? "");
  }
  if (Array.isArray(obj)) return obj.map(interpolateEnvVars);
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateEnvVars(value);
    }
    return result;
  }
  return obj;
}

/** Load and validate config */
export async function loadConfig(path?: string): Promise<AptConfig> {
  const configPath = path ?? findConfigFile();
  if (!configPath) {
    throw createModuleError(
      "config",
      "CONF_NF_002",
      "Config file not found. Run `apt init` first.",
    );
  }

  const file = Bun.file(configPath);
  const exists = await file.exists();
  if (!exists) {
    throw createModuleError("config", "CONF_NF_002", `Config file not found: ${configPath}`);
  }

  const content = await file.text();
  const raw = parseYaml(content);
  const interpolated = interpolateEnvVars(raw);

  const result = AptConfigSchema.safeParse(interpolated);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw createModuleError("config", "CONF_INV_001", `Invalid config: ${issues}`);
  }

  return result.data;
}

/** Write config to YAML file */
export async function writeConfig(config: Partial<AptConfig>, path: string): Promise<void> {
  const yaml = stringifyYaml(config, { lineWidth: 100 });
  await Bun.write(path, yaml);
}

/** Convert AptConfig to PipelineConfig */
export function configToPipelineConfig(config: AptConfig): PipelineConfig {
  return {
    target: config.target,
    compliance: config.compliance,
    execution: config.execution,
    analysis: config.analysis,
    reports: config.reports,
  };
}
