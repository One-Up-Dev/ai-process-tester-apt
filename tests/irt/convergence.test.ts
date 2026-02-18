import { describe, expect, test } from "bun:test";
import type { CATState, ConvergenceConfig } from "@apt/lib/types";
import { checkConvergence, getDefaultConfig } from "@apt/modules/executor/irt/convergence";

function makeState(overrides: Partial<CATState> = {}): CATState {
  return {
    theta: 0,
    se: 1.0,
    responses: [],
    startTime: Date.now(),
    dimension: "robustness",
    ...overrides,
  };
}

function makeResponses(n: number, thetaValues?: number[]): CATState["responses"] {
  return Array.from({ length: n }, (_, i) => ({
    itemId: `item-${i}`,
    response: (i % 2) as 0 | 1,
    theta: thetaValues ? thetaValues[i] : 0.5,
    se: 0.5,
    timestamp: Date.now() + i * 1000,
  }));
}

describe("checkConvergence", () => {
  const config = getDefaultConfig();

  test("converges when SE < threshold", () => {
    const state = makeState({
      se: 0.2,
      responses: makeResponses(5),
    });
    const result = checkConvergence(state, config);
    expect(result.converged).toBe(true);
    expect(result.reason).toContain("SE");
  });

  test("stops at maxTests", () => {
    const state = makeState({
      se: 0.5, // Still high
      responses: makeResponses(100),
    });
    const result = checkConvergence(state, { ...config, maxTests: 100 });
    expect(result.converged).toBe(true);
    expect(result.reason).toContain("Max tests");
  });

  test("stops at timeout", () => {
    const state = makeState({
      se: 0.5,
      startTime: Date.now() - 31 * 60 * 1000, // 31 minutes ago
      responses: makeResponses(10),
    });
    const result = checkConvergence(state, config);
    expect(result.converged).toBe(true);
    expect(result.reason).toContain("Timeout");
  });

  test("stable window detected (5 tests, delta < 0.1)", () => {
    const stableThetas = [0.5, 0.52, 0.51, 0.53, 0.52];
    const state = makeState({
      se: 0.5, // Still high SE to ensure this is what triggers
      responses: makeResponses(5, stableThetas),
    });
    const result = checkConvergence(state, config);
    expect(result.converged).toBe(true);
    expect(result.reason).toContain("stable");
  });

  test("no convergence if SE still high and not enough tests", () => {
    const state = makeState({
      se: 0.5,
      responses: makeResponses(3, [0.5, 0.8, 1.2]),
    });
    const result = checkConvergence(state, config);
    expect(result.converged).toBe(false);
  });

  test("window too short (< stableWindow) does not trigger convergence", () => {
    const state = makeState({
      se: 0.5,
      responses: makeResponses(3, [0.5, 0.51, 0.52]),
    });
    const result = checkConvergence(state, { ...config, stableWindow: 5 });
    expect(result.converged).toBe(false);
  });

  test("empty history does not converge", () => {
    const state = makeState();
    const result = checkConvergence(state, config);
    expect(result.converged).toBe(false);
  });

  test("multiple criteria simultaneously (SE wins first)", () => {
    const state = makeState({
      se: 0.1,
      responses: makeResponses(200),
      startTime: Date.now() - 60 * 60 * 1000,
    });
    const result = checkConvergence(state, config);
    expect(result.converged).toBe(true);
    // SE check comes first in the code
    expect(result.reason).toContain("SE");
  });

  test("custom config with different thresholds", () => {
    const customConfig: ConvergenceConfig = {
      seThreshold: 0.1,
      maxTests: 10,
      timeoutMs: 5000,
      stableWindow: 3,
      stableDelta: 0.05,
    };
    const state = makeState({
      se: 0.15, // Above custom threshold
      responses: makeResponses(10),
    });
    const result = checkConvergence(state, customConfig);
    expect(result.converged).toBe(true);
    expect(result.reason).toContain("Max tests");
  });

  test("stableDelta = 0 means any change blocks convergence via stability", () => {
    // Thetas with tiny but non-zero differences
    const thetas = [0.5, 0.5000001, 0.5, 0.5000001, 0.5];
    const state = makeState({
      se: 0.5,
      responses: makeResponses(5, thetas),
    });
    const strictConfig: ConvergenceConfig = {
      ...config,
      stableDelta: 0,
      maxTests: 1000, // Won't trigger
    };
    const result = checkConvergence(state, strictConfig);
    expect(result.converged).toBe(false);
  });
});
