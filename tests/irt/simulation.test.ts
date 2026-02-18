import { describe, expect, test } from "bun:test";
import type { IRTItem, TestDimension } from "@apt/lib/types";
import { CATEngine, probability } from "@apt/modules/executor/irt/index";

/** Seeded pseudo-random number generator (LCG) */
function createRng(seed: number) {
  let state = seed;
  return function next(): number {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/** Generate a pool of items with varied parameters */
function generateItemPool(
  n: number,
  dimension: TestDimension,
  rng: () => number,
  withGuessing = false,
): IRTItem[] {
  const items: IRTItem[] = [];
  for (let i = 0; i < n; i++) {
    items.push({
      id: `pool-${dimension}-${i}`,
      alpha: 0.5 + rng() * 2.0, // 0.5 to 2.5
      beta: -2 + rng() * 4, // -2 to +2
      gamma: withGuessing ? rng() * 0.15 : 0, // 0 to 0.15
      dimension,
    });
  }
  return items;
}

/** Pearson correlation coefficient */
function pearsonR(x: number[], y: number[]): number {
  const n = x.length;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return 0;
  return num / Math.sqrt(denX * denY);
}

/** RMSE */
function rmse(x: number[], y: number[]): number {
  const n = x.length;
  let sumSqDiff = 0;
  for (let i = 0; i < n; i++) {
    sumSqDiff += (x[i] - y[i]) ** 2;
  }
  return Math.sqrt(sumSqDiff / n);
}

describe("CAT Simulation (acceptance tests)", () => {
  test("Full CAT simulation: 100 systems, gamma=0, correlation > 0.95", () => {
    const rng = createRng(12345);
    const nSystems = 100;
    const nItems = 50;
    const items = generateItemPool(nItems, "robustness", rng, false);

    const trueThetas: number[] = [];
    const estimatedThetas: number[] = [];
    const finalSEs: number[] = [];
    const nTestsUsed: number[] = [];

    for (let s = 0; s < nSystems; s++) {
      const trueTheta = -3 + (s / (nSystems - 1)) * 6; // -3 to +3
      trueThetas.push(trueTheta);

      const engine = new CATEngine(items, "robustness", {
        seThreshold: 0.3,
        maxTests: nItems,
      });

      let testsRun = 0;
      while (true) {
        const conv = engine.isConverged();
        if (conv.converged) break;

        const nextItem = engine.nextItem();
        if (!nextItem) break;

        // Simulate response
        const p = probability(trueTheta, nextItem.alpha, nextItem.beta, nextItem.gamma);
        const response: 0 | 1 = rng() < p ? 1 : 0;
        engine.recordResponse(nextItem.id, response);
        testsRun++;

        if (testsRun >= nItems) break;
      }

      const results = engine.getResults();
      estimatedThetas.push(results.theta);
      finalSEs.push(results.se);
      nTestsUsed.push(results.nTests);
    }

    const r = pearsonR(trueThetas, estimatedThetas);
    const meanSE = finalSEs.reduce((a, b) => a + b, 0) / finalSEs.length;
    const meanTests = nTestsUsed.reduce((a, b) => a + b, 0) / nTestsUsed.length;
    const rmsVal = rmse(trueThetas, estimatedThetas);

    // Assertions
    expect(r).toBeGreaterThan(0.95);
    // Mean SE can exceed seThreshold because extreme-theta systems may exhaust
    // all items before converging (items beta in [-2,+2] vs theta in [-3,+3])
    expect(meanSE).toBeLessThan(0.4);
    expect(meanTests).toBeLessThan(30);
    expect(rmsVal).toBeLessThan(0.5);
  });

  test("Full CAT simulation: with guessing (gamma > 0)", () => {
    const rng = createRng(67890);
    const nSystems = 100;
    const nItems = 50;
    const items = generateItemPool(nItems, "robustness", rng, true);

    const trueThetas: number[] = [];
    const estimatedThetas: number[] = [];

    for (let s = 0; s < nSystems; s++) {
      const trueTheta = -3 + (s / (nSystems - 1)) * 6;
      trueThetas.push(trueTheta);

      const engine = new CATEngine(items, "robustness", {
        seThreshold: 0.3,
        maxTests: nItems,
      });

      let testsRun = 0;
      while (true) {
        const conv = engine.isConverged();
        if (conv.converged) break;

        const nextItem = engine.nextItem();
        if (!nextItem) break;

        const p = probability(trueTheta, nextItem.alpha, nextItem.beta, nextItem.gamma);
        const response: 0 | 1 = rng() < p ? 1 : 0;
        engine.recordResponse(nextItem.id, response);
        testsRun++;

        if (testsRun >= nItems) break;
      }

      const results = engine.getResults();
      estimatedThetas.push(results.theta);
    }

    const r = pearsonR(trueThetas, estimatedThetas);
    // With guessing, correlation might be slightly lower
    expect(r).toBeGreaterThan(0.9);
  });

  test("CATEngine getResults includes all expected fields", () => {
    const rng = createRng(11111);
    const items = generateItemPool(20, "security", rng, false);
    const engine = new CATEngine(items, "security");

    // Administer a few items
    for (let i = 0; i < 5; i++) {
      const nextItem = engine.nextItem();
      if (!nextItem) break;
      const response: 0 | 1 = rng() < 0.5 ? 1 : 0;
      engine.recordResponse(nextItem.id, response);
    }

    const results = engine.getResults();
    expect(typeof results.theta).toBe("number");
    expect(typeof results.se).toBe("number");
    expect(typeof results.ciLower).toBe("number");
    expect(typeof results.ciUpper).toBe("number");
    expect(typeof results.normalizedScore).toBe("number");
    expect(results.nTests).toBe(5);
    expect(results.dimension).toBe("security");
    expect(results.ciLower).toBeLessThan(results.theta);
    expect(results.ciUpper).toBeGreaterThan(results.theta);
    expect(results.normalizedScore).toBeGreaterThanOrEqual(0);
    expect(results.normalizedScore).toBeLessThanOrEqual(100);
  });

  test("CATEngine state tracking is consistent", () => {
    const rng = createRng(22222);
    const items = generateItemPool(30, "fairness", rng, false);
    const engine = new CATEngine(items, "fairness");

    const thetaHistory: number[] = [];

    for (let i = 0; i < 10; i++) {
      const nextItem = engine.nextItem();
      if (!nextItem) break;
      const response: 0 | 1 = rng() < 0.6 ? 1 : 0;
      const result = engine.recordResponse(nextItem.id, response);
      thetaHistory.push(result.theta);
    }

    const state = engine.getState();
    expect(state.responses.length).toBe(10);
    expect(state.dimension).toBe("fairness");
    // Last recorded theta should match state theta
    expect(state.theta).toBe(thetaHistory[thetaHistory.length - 1]);
  });

  test("CAT converges faster with high-discrimination items", () => {
    const rng1 = createRng(33333);
    const rng2 = createRng(33333); // Same seed for fair comparison

    // High alpha pool
    const highAlphaItems: IRTItem[] = [];
    for (let i = 0; i < 50; i++) {
      highAlphaItems.push({
        id: `high-${i}`,
        alpha: 2.0 + rng1() * 0.5, // 2.0 to 2.5
        beta: -2 + rng1() * 4,
        gamma: 0,
        dimension: "robustness",
      });
    }

    // Low alpha pool
    const lowAlphaItems: IRTItem[] = [];
    for (let i = 0; i < 50; i++) {
      lowAlphaItems.push({
        id: `low-${i}`,
        alpha: 0.3 + rng2() * 0.2, // 0.3 to 0.5
        beta: -2 + rng2() * 4,
        gamma: 0,
        dimension: "robustness",
      });
    }

    const trueTheta = 0.5;
    const simRng1 = createRng(44444);
    const simRng2 = createRng(44444);

    // Run CAT with high alpha
    const engineHigh = new CATEngine(highAlphaItems, "robustness", {
      seThreshold: 0.3,
      maxTests: 50,
    });
    let highTests = 0;
    while (!engineHigh.isConverged().converged) {
      const item = engineHigh.nextItem();
      if (!item) break;
      const p = probability(trueTheta, item.alpha, item.beta, item.gamma);
      engineHigh.recordResponse(item.id, simRng1() < p ? 1 : 0);
      highTests++;
      if (highTests >= 50) break;
    }

    // Run CAT with low alpha
    const engineLow = new CATEngine(lowAlphaItems, "robustness", {
      seThreshold: 0.3,
      maxTests: 50,
    });
    let lowTests = 0;
    while (!engineLow.isConverged().converged) {
      const item = engineLow.nextItem();
      if (!item) break;
      const p = probability(trueTheta, item.alpha, item.beta, item.gamma);
      engineLow.recordResponse(item.id, simRng2() < p ? 1 : 0);
      lowTests++;
      if (lowTests >= 50) break;
    }

    // High discrimination should converge faster (fewer tests)
    expect(highTests).toBeLessThan(lowTests);
  });
});
