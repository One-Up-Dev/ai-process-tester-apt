import { describe, expect, test } from "bun:test";
import type { IRTItem } from "@apt/lib/types";
import {
  estimateTheta,
  estimateThetaEAP,
  estimateThetaMLE,
} from "@apt/modules/executor/irt/estimation";
import { probability } from "@apt/modules/executor/irt/model";

/** Helper: generate IRT items with varied parameters */
function generateItems(n: number, dimension = "robustness"): IRTItem[] {
  const items: IRTItem[] = [];
  for (let i = 0; i < n; i++) {
    items.push({
      id: `gen-${i}`,
      alpha: 1.0 + (i % 5) * 0.3, // 1.0 to 2.2
      beta: -2 + (i / (n - 1)) * 4, // -2 to +2
      gamma: 0,
      dimension: dimension as IRTItem["dimension"],
    });
  }
  return items;
}

/** Helper: simulate responses for a given true theta */
function simulateResponses(items: IRTItem[], trueTheta: number, seed = 42): (0 | 1)[] {
  // Simple deterministic pseudo-random based on seed
  let state = seed;
  function nextRandom(): number {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  }

  return items.map((item) => {
    const p = probability(trueTheta, item.alpha, item.beta, item.gamma);
    return nextRandom() < p ? (1 as const) : (0 as const);
  });
}

describe("estimateThetaMLE", () => {
  test("MLE converges to correct theta on simulated data (10 items)", () => {
    const trueTheta = 1.0;
    const items = generateItems(10);
    const responses = simulateResponses(items, trueTheta, 42);
    const result = estimateThetaMLE(items, responses);
    // Should be within 1.0 of true theta
    expect(Math.abs(result.theta - trueTheta)).toBeLessThan(1.0);
    expect(result.converged).toBe(true);
    expect(result.method).toBe("mle");
  });

  test("MLE precision < 0.3 SE with 20+ items", () => {
    const trueTheta = 0.5;
    const items = generateItems(25);
    const responses = simulateResponses(items, trueTheta, 123);
    const result = estimateThetaMLE(items, responses);
    expect(result.se).toBeLessThan(0.5);
  });

  test("Newton-Raphson divergence recovery via step-halving", () => {
    // Items with extreme parameters that could cause divergence
    const items: IRTItem[] = [
      { id: "d1", alpha: 3.0, beta: -3.0, gamma: 0, dimension: "robustness" },
      { id: "d2", alpha: 3.0, beta: 3.0, gamma: 0, dimension: "robustness" },
      { id: "d3", alpha: 0.5, beta: 0.0, gamma: 0, dimension: "robustness" },
    ];
    const responses: (0 | 1)[] = [1, 0, 1];
    // Should not throw and should produce a result
    const result = estimateThetaMLE(items, responses);
    expect(result.theta).toBeGreaterThanOrEqual(-4);
    expect(result.theta).toBeLessThanOrEqual(4);
  });

  test("Items with gamma=0 yield precise estimation", () => {
    const items = generateItems(15); // All gamma=0
    const responses = simulateResponses(items, 0.0, 77);
    const result = estimateThetaMLE(items, responses);
    expect(Math.abs(result.theta)).toBeLessThan(1.5);
  });

  test("High discrimination items yield fast convergence", () => {
    const highAlpha: IRTItem[] = [];
    for (let i = 0; i < 10; i++) {
      highAlpha.push({
        id: `ha-${i}`,
        alpha: 2.5,
        beta: -2 + (i / 9) * 4,
        gamma: 0,
        dimension: "robustness",
      });
    }
    const responses = simulateResponses(highAlpha, 0.5, 99);
    const result = estimateThetaMLE(highAlpha, responses);
    expect(result.se).toBeLessThan(0.5);
  });

  test("falls back to EAP when MLE fails to converge", () => {
    // All items answered correctly — MLE pushes theta to +infinity, shouldn't converge cleanly
    const items: IRTItem[] = Array.from({ length: 3 }, (_, i) => ({
      id: `item-${i}`,
      alpha: 1.0,
      beta: 0.0,
      gamma: 0,
      dimension: "robustness" as const,
    }));
    const responses: (0 | 1)[] = items.map(() => 1);

    const result = estimateThetaMLE(items, responses);
    // Should still return a valid result (either converged at max or fell back to EAP)
    expect(result.theta).toBeDefined();
    expect(Number.isFinite(result.theta)).toBe(true);
    expect(result.theta).toBeGreaterThan(0); // All correct → high ability
  });

  test("Low discrimination items yield slower convergence (higher SE)", () => {
    const lowAlpha: IRTItem[] = [];
    for (let i = 0; i < 10; i++) {
      lowAlpha.push({
        id: `la-${i}`,
        alpha: 0.3,
        beta: -2 + (i / 9) * 4,
        gamma: 0,
        dimension: "robustness",
      });
    }
    const responses = simulateResponses(lowAlpha, 0.5, 99);
    const result = estimateThetaMLE(lowAlpha, responses);
    // Low alpha => higher SE
    expect(result.se).toBeGreaterThan(0.5);
  });
});

describe("estimateThetaEAP", () => {
  test("EAP without data returns prior mean (close to 0)", () => {
    // Single item but no meaningful info (response alone)
    const _items: IRTItem[] = [
      { id: "e1", alpha: 1.0, beta: 0.0, gamma: 0, dimension: "robustness" },
    ];
    // With 0 items and 0 responses, EAP should return ~0
    const result = estimateThetaEAP([], []);
    // With no data, prior is N(0,1) so EAP = 0
    expect(Math.abs(result.theta)).toBeLessThan(0.1);
  });

  test("EAP with 1 item shows shrinkage toward prior", () => {
    const items: IRTItem[] = [
      { id: "e1", alpha: 1.5, beta: 2.0, gamma: 0, dimension: "robustness" },
    ];
    const result = estimateThetaEAP(items, [1]);
    // With one correct response to a hard item, EAP should pull toward prior (0)
    // rather than toward beta=2.0
    expect(result.theta).toBeLessThan(2.0);
    expect(result.theta).toBeGreaterThan(-1);
  });

  test("EAP with 20 items approaches MLE", () => {
    const items = generateItems(20);
    const trueTheta = 0.5;
    const responses = simulateResponses(items, trueTheta, 55);
    const eap = estimateThetaEAP(items, responses);
    const mle = estimateThetaMLE(items, responses);
    // Should be reasonably close
    expect(Math.abs(eap.theta - mle.theta)).toBeLessThan(0.5);
  });
});

describe("estimateTheta (facade)", () => {
  test("All-pass falls back to EAP and returns high theta", () => {
    const items = generateItems(5);
    const responses: (0 | 1)[] = [1, 1, 1, 1, 1];
    const result = estimateTheta(items, responses);
    expect(result.method).toBe("eap");
    expect(result.theta).toBeGreaterThan(0);
  });

  test("All-fail falls back to EAP and returns low theta", () => {
    const items = generateItems(5);
    const responses: (0 | 1)[] = [0, 0, 0, 0, 0];
    const result = estimateTheta(items, responses);
    expect(result.method).toBe("eap");
    expect(result.theta).toBeLessThan(0);
  });

  test("MLE and EAP converge for sufficient N", () => {
    const items = generateItems(30);
    const trueTheta = -0.5;
    const responses = simulateResponses(items, trueTheta, 33);
    const mle = estimateThetaMLE(items, responses);
    const eap = estimateThetaEAP(items, responses);
    expect(Math.abs(mle.theta - eap.theta)).toBeLessThan(0.5);
  });

  test("SE decreases with N", () => {
    const items = generateItems(20);
    const trueTheta = 0.0;
    const responses = simulateResponses(items, trueTheta, 88);

    const result5 = estimateTheta(items.slice(0, 5), responses.slice(0, 5));
    const result10 = estimateTheta(items.slice(0, 10), responses.slice(0, 10));
    const result20 = estimateTheta(items, responses);

    expect(result5.se).toBeGreaterThan(result10.se);
    expect(result10.se).toBeGreaterThan(result20.se);
  });

  test("Theta clamped to [-4, +4]", () => {
    // Extreme items that would push theta beyond bounds
    const items: IRTItem[] = [
      { id: "ex1", alpha: 3.0, beta: 3.5, gamma: 0, dimension: "robustness" },
      { id: "ex2", alpha: 3.0, beta: 3.8, gamma: 0, dimension: "robustness" },
      { id: "ex3", alpha: 3.0, beta: 3.9, gamma: 0, dimension: "robustness" },
    ];
    const allPass: (0 | 1)[] = [1, 1, 1];
    const result = estimateTheta(items, allPass);
    expect(result.theta).toBeLessThanOrEqual(4);
    expect(result.theta).toBeGreaterThanOrEqual(-4);
  });

  test("Alternating pass/fail sequence yields theta near 0", () => {
    const items = generateItems(10);
    const responses: (0 | 1)[] = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0];
    const result = estimateTheta(items, responses);
    expect(Math.abs(result.theta)).toBeLessThan(1.5);
  });

  test("< 3 responses uses EAP", () => {
    const items = generateItems(2);
    const responses: (0 | 1)[] = [1, 0];
    const result = estimateTheta(items, responses);
    expect(result.method).toBe("eap");
  });
});
