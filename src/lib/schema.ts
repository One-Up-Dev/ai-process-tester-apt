import { z } from "zod";

const systemTypes = [
  "chatbot",
  "classifier",
  "rag",
  "agent",
  "pipeline",
  "vision",
  "audio",
  "embedding",
  "custom",
] as const;

const adapterTypes = ["http", "cli", "sdk-openai", "sdk-anthropic", "docker"] as const;

export const TargetConfigSchema = z.object({
  url: z.string().url(),
  adapter: z.enum(adapterTypes).default("http"),
  model: z.string().optional(),
  auth: z
    .object({
      type: z.enum(["bearer", "api-key", "basic", "none"]),
      token: z.string().optional(),
      header: z.string().optional(),
    })
    .optional(),
  headers: z.record(z.string()).optional(),
  timeout_ms: z.number().positive().default(120000),
  system_type: z.union([z.enum(systemTypes), z.literal("auto")]).default("auto"),
});

export const ComplianceConfigSchema = z.object({
  jurisdiction: z.enum(["EU", "US", "global"]),
  risk_classification: z.enum(["minimal", "limited", "high-risk", "unacceptable"]),
  sector: z.enum(["finance", "healthcare", "legal", "education", "general"]),
  standards: z.array(z.string()),
  exclusions: z.array(z.string()).default([]),
});

export const ExecutionConfigSchema = z.object({
  mode: z.enum(["adaptive", "exhaustive"]).default("adaptive"),
  se_threshold: z.number().positive().default(0.3),
  max_tests: z.number().int().positive().default(100),
  timeout_minutes: z.number().positive().default(30),
  concurrency: z.number().int().positive().default(4),
  replications: z.number().int().positive().default(3),
  warmup_count: z.number().int().min(0).default(3),
});

export const AnalysisConfigSchema = z.object({
  confidence_level: z.number().min(0).max(1).default(0.95),
  drift_detection: z.boolean().default(true),
  effect_size_threshold: z.number().positive().default(0.5),
  power_target: z.number().min(0).max(1).default(0.8),
});

export const ReportsConfigSchema = z.object({
  formats: z.array(z.string()).default(["json", "html"]),
  output_dir: z.string().default("./apt-reports"),
  include_raw_data: z.boolean().default(false),
  template: z.string().optional(),
});

export const StorageConfigSchema = z.object({
  database: z.string().default("apt.db"),
  retention_days: z.number().int().positive().default(90),
});

export const BackendsConfigSchema = z.object({
  enabled: z.array(z.string()).default(["custom"]),
  promptfoo: z.object({ path: z.string().optional() }).optional(),
  deepeval: z.object({ path: z.string().optional() }).optional(),
});

export const PluginsConfigSchema = z.object({
  detectors: z.array(z.string()).default([]),
  backends: z.array(z.string()).default([]),
});

export const IntegrationsConfigSchema = z.object({
  langfuse: z
    .object({
      enabled: z.boolean().default(false),
      host: z.string().url().optional(),
      public_key: z.string().optional(),
      secret_key: z.string().optional(),
    })
    .optional(),
});

export const AptConfigSchema = z.object({
  version: z.string().default("1"),
  target: TargetConfigSchema,
  compliance: ComplianceConfigSchema.optional(),
  execution: ExecutionConfigSchema.default({}),
  analysis: AnalysisConfigSchema.default({}),
  reports: ReportsConfigSchema.default({}),
  storage: StorageConfigSchema.default({}),
  backends: BackendsConfigSchema.default({}),
  plugins: PluginsConfigSchema.default({}),
  integrations: IntegrationsConfigSchema.optional(),
});

export type AptConfig = z.infer<typeof AptConfigSchema>;

// === Test Definition Schema (YAML library) ===
const testCategories = [
  "functional",
  "robustness",
  "security",
  "fairness",
  "performance",
  "compliance",
] as const;

const testDimensions = [
  "functional",
  "robustness",
  "security",
  "fairness",
  "performance",
  "compliance",
] as const;

export const TestEvaluatorSchema = z.object({
  type: z.enum(["contains", "not_contains", "regex", "not_regex", "llm-judge", "score_threshold"]),
  value: z.string().optional(),
  threshold: z.number().optional(),
  prompt: z.string().optional(),
});

export const TestDefinitionSchema = z.object({
  id: z.string(),
  version: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.enum(testCategories),
  dimension: z.enum(testDimensions),
  system_types: z.array(z.enum(systemTypes)),
  irt: z.object({
    difficulty: z.number(),
    discrimination: z.number().positive(),
    guessing: z.number().min(0).max(1),
    calibration_n: z.number().int().min(0),
    calibration_date: z.string(),
    is_preliminary: z.boolean(),
  }),
  input: z.object({
    type: z.enum(["text", "image", "audio", "multimodal"]),
    content: z.string(),
    context: z
      .object({
        system_prompt: z.string().optional(),
        conversation_history: z
          .array(
            z.object({
              role: z.string(),
              content: z.string(),
            }),
          )
          .optional(),
        metadata: z.record(z.unknown()).optional(),
      })
      .optional(),
  }),
  expected: z.object({
    behavior: z.string(),
    evaluators: z.array(TestEvaluatorSchema),
  }),
  compliance: z
    .array(
      z.object({
        standard: z.string(),
        article: z.string(),
        description: z.string(),
      }),
    )
    .optional(),
  tags: z.array(z.string()),
  backends: z.array(z.string()),
  estimated_duration_ms: z.number().positive(),
});
