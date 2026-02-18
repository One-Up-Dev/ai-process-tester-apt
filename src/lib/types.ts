// === APT Core Types ===
// Canonical source: 04-technical.md + app_spec-apt.txt
// ALL inter-module interfaces are defined here.

// === ENUMS ===
export type SystemType =
  | "chatbot"
  | "classifier"
  | "rag"
  | "agent"
  | "pipeline"
  | "vision"
  | "audio"
  | "embedding"
  | "custom";

export type EvaluationMode = "adaptive" | "exhaustive";

export type EvaluationStatus = "running" | "completed" | "failed" | "cancelled";

export type TestDimension =
  | "robustness"
  | "fairness"
  | "security"
  | "performance"
  | "compliance"
  | "functional";

export type TestCategory =
  | "functional"
  | "robustness"
  | "security"
  | "fairness"
  | "performance"
  | "compliance";

export type AdapterType = "http" | "cli" | "sdk-openai" | "sdk-anthropic" | "docker";

// === MODULE ERROR (unified pattern) ===
export interface ModuleError {
  module: string;
  severity: "warning" | "error" | "fatal";
  code: string;
  message: string;
  recoverable: boolean;
  fallback?: string;
}

// === SYSTEM ADAPTER (canonical: 04-technical.md) ===
export interface TargetConfig {
  url: string;
  adapter: AdapterType;
  model?: string;
  auth?: {
    type: "bearer" | "api-key" | "basic" | "none";
    token?: string;
    header?: string;
  };
  headers?: Record<string, string>;
  timeout_ms?: number;
  system_type?: SystemType | "auto";
}

export interface TestInput {
  type: "text" | "image" | "audio" | "multimodal";
  content: string;
  context?: {
    system_prompt?: string;
    conversation_history?: Array<{ role: string; content: string }>;
    metadata?: Record<string, unknown>;
  };
}

export interface SystemOutput {
  content: string;
  format: "text" | "json" | "markdown";
  latency_ms: number;
  tokens_used?: { input: number; output: number };
  metadata?: Record<string, unknown>;
}

export interface SystemMetadata {
  reachable: boolean;
  response_format?: string;
  detected_provider?: string;
  headers?: Record<string, string>;
}

export interface SystemAdapter {
  id: string;
  type: AdapterType;
  connect(config: TargetConfig): Promise<void>;
  send(input: TestInput): Promise<SystemOutput>;
  disconnect(): Promise<void>;
  inspect(): Promise<SystemMetadata>;
}

// === EXECUTION BACKEND (canonical: 04-technical.md) ===
export interface ExecutionBackend {
  id: string;
  name: string;
  supported_categories: TestCategory[];
  capabilities: {
    supports_replications: boolean;
    supports_streaming: boolean;
    supports_multimodal: boolean;
    supports_multi_turn: boolean;
  };
  healthcheck(): Promise<{ available: boolean; version?: string; error?: string }>;
  execute(test: PlannedTest, adapter: SystemAdapter): Promise<TestResult>;
  executeBatch?(tests: PlannedTest[], adapter: SystemAdapter): Promise<TestResult[]>;
}

// === DETECTOR PLUGIN ===
export interface DetectionResult {
  system_type: SystemType | null;
  confidence: number;
  evidence: Record<string, unknown>;
}

export interface DetectionContext {
  target: TargetConfig;
  partialResults: DetectionResult[];
  adapter?: SystemAdapter;
}

export interface Detector {
  name: string;
  priority: number;
  detect(target: TargetConfig, context: DetectionContext): Promise<DetectionResult>;
}

// === SYSTEM PROFILE ===
export interface SystemProfile {
  id: string;
  detected_at: string;
  system_type: SystemType;
  detection_confidence: number;
  detection_methods: Array<{
    method: string;
    confidence: number;
    evidence: Record<string, unknown>;
  }>;
  input_interfaces: Array<{
    type: string;
    format: string;
    constraints?: Record<string, unknown>;
  }>;
  output_interfaces: Array<{
    type: string;
    format: string;
    latency?: number;
  }>;
  capabilities: string[];
  dependencies: Array<{
    framework?: string;
    provider?: string;
    model?: string;
  }>;
  adapter: TargetConfig;
  baseline_metrics?: {
    latency_p50: number;
    latency_p95: number;
    latency_p99: number;
    determinism: number;
    format: string;
  };
}

// === IRT TYPES ===
export interface IRTItem {
  id: string;
  alpha: number; // discrimination
  beta: number; // difficulty
  gamma: number; // guessing
  dimension: TestDimension;
  is_preliminary?: boolean;
}

export interface CATState {
  theta: number;
  se: number;
  responses: Array<{
    itemId: string;
    response: 0 | 1;
    theta: number;
    se: number;
    timestamp: number;
  }>;
  startTime: number;
  dimension: TestDimension;
}

export interface ConvergenceConfig {
  seThreshold: number; // default 0.3
  maxTests: number; // default 100
  timeoutMs: number; // default 30 * 60 * 1000
  stableWindow: number; // default 5
  stableDelta: number; // default 0.1
}

// === PIPELINE INTERFACES ===
export interface PipelineConfig {
  target: TargetConfig;
  compliance?: ComplianceConfig;
  execution: ExecutionConfig;
  analysis: AnalysisConfig;
  reports: ReportConfig;
}

export interface ComplianceConfig {
  jurisdiction: "EU" | "US" | "global";
  risk_classification: "minimal" | "limited" | "high-risk" | "unacceptable";
  sector: "finance" | "healthcare" | "legal" | "education" | "general";
  standards: string[];
  exclusions: string[];
}

export interface ExecutionConfig {
  mode: EvaluationMode;
  se_threshold: number;
  max_tests: number;
  timeout_minutes: number;
  concurrency: number;
  replications: number;
  warmup_count: number;
}

export interface AnalysisConfig {
  confidence_level: number;
  drift_detection: boolean;
  effect_size_threshold: number;
  power_target: number;
}

export interface ReportConfig {
  formats: string[];
  output_dir: string;
  include_raw_data: boolean;
  template?: string;
}

export interface PlannedTest {
  id: string;
  name: string;
  dimension: TestDimension;
  category: TestCategory;
  input: TestInput;
  expected_behavior: string;
  irt_params: {
    alpha: number;
    beta: number;
    gamma: number;
  };
  backend_id?: string;
  metadata?: Record<string, unknown>;
}

export interface TestResult {
  test_id: string;
  backend_id: string;
  passed: boolean;
  score: number;
  metrics: Record<string, number>;
  raw_output: string;
  duration_ms: number;
  replications?: Array<{
    passed: boolean;
    score: number;
    duration_ms: number;
  }>;
  metadata: Record<string, unknown>;
}

export interface TestPlan {
  tests: PlannedTest[];
  dimensions: TestDimension[];
  strategy: EvaluationMode;
  estimates: {
    estimated_tests: number;
    estimated_time_ms: number;
  };
}

export interface ComplianceReport {
  jurisdiction: string;
  risk_classification: string;
  standards: Array<{
    name: string;
    requirements: Array<{
      id: string;
      description: string;
      criticality: "critical" | "major" | "minor";
      mapped_tests: string[];
    }>;
  }>;
  gaps: Array<{
    requirement_id: string;
    description: string;
    criticality: string;
  }>;
  traceability_matrix: Record<string, string[]>;
}

export interface ExecutionResults {
  evaluation_id: string;
  system_profile: SystemProfile;
  test_results: TestResult[];
  irt_estimates: IRTEstimate[];
  execution_metadata: Record<string, unknown>;
  planned_tests?: PlannedTest[];
}

export interface AnalysisReport {
  evaluation_id: string;
  summary: {
    overall_score: number;
    overall_grade: string;
    dimensions_tested: number;
    total_tests: number;
    duration_ms: number;
  };
  dimensions: Array<{
    dimension: TestDimension;
    theta: number;
    se: number;
    normalized_score: number;
    grade: string;
    n_tests: number;
    ci_lower: number;
    ci_upper: number;
  }>;
  compliance: unknown;
  drift: unknown;
  comparisons: unknown[];
  recommendations: Array<{
    dimension: TestDimension;
    priority: "high" | "medium" | "low";
    description: string;
  }>;
  trace: {
    pipeline_version: string;
    started_at: string;
    completed_at: string;
    modules: string[];
  };
  test_details?: TestDetail[];
  system_profile?: SystemProfileSummary;
  execution_metadata_summary?: ExecutionMetadataSummary;
}

// === REPORT DETAIL TYPES ===

export interface EvaluatorResult {
  type: string;
  passed: boolean;
  detail: string;
}

export interface TestDetail {
  test_id: string;
  name: string;
  description: string;
  dimension: TestDimension;
  category: TestCategory;
  tags: string[];
  input_content: string;
  expected_behavior: string;
  raw_output: string;
  passed: boolean;
  score: number;
  duration_ms: number;
  evaluator_results: EvaluatorResult[];
  noise_cv?: number;
  noise_flag?: boolean;
  replications?: Array<{ passed: boolean; score: number; duration_ms: number }>;
  irt_params?: { alpha: number; beta: number; gamma: number };
  irt_theta_at_time?: number;
  irt_se_at_time?: number;
  selection_reason?: string;
  compliance?: Array<{ standard: string; article: string; description: string }>;
}

export interface SystemProfileSummary {
  system_type: SystemType;
  detection_confidence: number;
  detection_methods: Array<{ method: string; confidence: number }>;
  capabilities: string[];
  baseline_metrics?: {
    latency_p50: number;
    latency_p95: number;
    latency_p99: number;
    determinism: number;
    format: string;
  };
}

export interface ExecutionMetadataSummary {
  strategy: string;
  backends_used: string[];
  total_duration_ms: number;
}

export interface IRTEstimate {
  dimension: TestDimension;
  theta: number;
  se: number;
  ci_lower: number;
  ci_upper: number;
  n_tests: number;
  normalized_score: number;
}

// === PIPELINE INTERFACE ===
export interface Pipeline {
  run(config: PipelineConfig): Promise<AnalysisReport>;
  introspect(target: TargetConfig): Promise<SystemProfile>;
  map(profile: SystemProfile, compliance: ComplianceConfig): Promise<ComplianceReport>;
  generate(profile: SystemProfile, compliance?: ComplianceReport): Promise<TestPlan>;
  execute(plan: TestPlan, adapter: SystemAdapter): Promise<ExecutionResults>;
  analyze(results: ExecutionResults): Promise<AnalysisReport>;
  on(event: string, handler: (data: unknown) => void): void;
  off(event: string, handler: (data: unknown) => void): void;
}

// === TEST DEFINITION (YAML library format) ===
export interface TestEvaluator {
  type: "contains" | "not_contains" | "regex" | "not_regex" | "llm-judge" | "score_threshold";
  value?: string;
  threshold?: number;
  prompt?: string;
}

export interface TestDefinition {
  id: string;
  version: string;
  name: string;
  description: string;
  category: TestCategory;
  dimension: TestDimension;
  system_types: SystemType[];

  irt: {
    difficulty: number;
    discrimination: number;
    guessing: number;
    calibration_n: number;
    calibration_date: string;
    is_preliminary: boolean;
  };

  input: TestInput;

  expected: {
    behavior: string;
    evaluators: TestEvaluator[];
  };

  compliance?: Array<{
    standard: string;
    article: string;
    description: string;
  }>;

  tags: string[];
  backends: string[];
  estimated_duration_ms: number;
}

// === GRADES ===
export const GRADE_BOUNDARIES = {
  A: 85,
  B: 70,
  C: 55,
  D: 40,
} as const;

export type Grade = "A" | "B" | "C" | "D" | "F";

export function computeGrade(score: number): Grade {
  if (score >= GRADE_BOUNDARIES.A) return "A";
  if (score >= GRADE_BOUNDARIES.B) return "B";
  if (score >= GRADE_BOUNDARIES.C) return "C";
  if (score >= GRADE_BOUNDARIES.D) return "D";
  return "F";
}

// === EXIT CODES ===
export const EXIT_CODES = { PASS: 0, FAIL: 1, ERROR: 2 } as const;

// === CONSTANTS ===
export const DETECTION_CONFIDENCE_THRESHOLD = 0.7;
