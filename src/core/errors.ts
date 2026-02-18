import type { ModuleError } from "@apt/lib/types";

export class AptError extends Error {
  constructor(public readonly moduleError: ModuleError) {
    super(moduleError.message);
    this.name = "AptError";
  }

  get isRecoverable(): boolean {
    return this.moduleError.recoverable;
  }

  get severity(): string {
    return this.moduleError.severity;
  }
}

export function createModuleError(
  module: string,
  code: string,
  message: string,
  opts?: Partial<ModuleError>,
): AptError {
  return new AptError({
    module,
    severity: "error",
    code,
    message,
    recoverable: false,
    ...opts,
  });
}

export const ERROR_CODES = {
  INTROSPECTOR_CONNECTION_FAILED: "INTRO_CONN_001",
  INTROSPECTOR_DETECTION_LOW_CONFIDENCE: "INTRO_DET_002",
  EXECUTOR_BACKEND_UNAVAILABLE: "EXEC_BACK_001",
  EXECUTOR_TOO_MANY_FAILURES: "EXEC_FAIL_002",
  ANALYZER_STORAGE_FAILED: "ANAL_STOR_001",
  CONFIG_INVALID: "CONF_INV_001",
  CONFIG_NOT_FOUND: "CONF_NF_002",
} as const;
