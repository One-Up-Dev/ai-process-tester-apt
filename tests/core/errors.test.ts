import { describe, expect, test } from "bun:test";
import { AptError, ERROR_CODES, createModuleError } from "@apt/core/errors";

describe("AptError", () => {
  test("createModuleError produces AptError with correct fields", () => {
    const err = createModuleError("introspector", "INTRO_CONN_001", "Connection failed", {
      severity: "fatal",
      fallback: "Use cached profile",
    });

    expect(err).toBeInstanceOf(AptError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AptError");
    expect(err.message).toBe("Connection failed");
    expect(err.moduleError.module).toBe("introspector");
    expect(err.moduleError.code).toBe("INTRO_CONN_001");
    expect(err.moduleError.severity).toBe("fatal");
    expect(err.moduleError.recoverable).toBe(false);
    expect(err.moduleError.fallback).toBe("Use cached profile");
  });

  test("isRecoverable returns true when recoverable is true, false otherwise", () => {
    const recoverableErr = createModuleError("executor", "EXEC_BACK_001", "Backend unavailable", {
      recoverable: true,
    });
    expect(recoverableErr.isRecoverable).toBe(true);

    const fatalErr = createModuleError("executor", "EXEC_FAIL_002", "Too many failures");
    expect(fatalErr.isRecoverable).toBe(false);
  });

  test("severity getter returns the correct severity level", () => {
    const warningErr = createModuleError("analyzer", "ANAL_STOR_001", "Storage warning", {
      severity: "warning",
    });
    expect(warningErr.severity).toBe("warning");

    const errorErr = createModuleError("config", "CONF_INV_001", "Invalid config");
    expect(errorErr.severity).toBe("error");

    const fatalErr = createModuleError("pipeline", "PIPE_FAIL", "Fatal failure", {
      severity: "fatal",
    });
    expect(fatalErr.severity).toBe("fatal");
  });

  test("all ERROR_CODES are defined and non-empty strings", () => {
    const codes = Object.entries(ERROR_CODES);
    expect(codes.length).toBeGreaterThanOrEqual(7);

    for (const [key, value] of codes) {
      expect(typeof key).toBe("string");
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });
});
