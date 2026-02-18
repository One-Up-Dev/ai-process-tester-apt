import { describe, expect, test } from "bun:test";
import type { IRTItem } from "@apt/lib/types";
import {
  fisherInformation,
  logLikelihood,
  normalizedScore,
  probability,
  standardError,
  totalInformation,
} from "@apt/modules/executor/irt/model";

import expected from "../fixtures/irt-expected.json";
import items from "../fixtures/irt-items.json";

const typedItems = items as IRTItem[];

describe("probability (ICC)", () => {
  test("probability(theta=beta) should be approximately (1+gamma)/2", () => {
    const alpha = 1.5;
    const beta = 0.5;
    const gamma = 0.2;
    const p = probability(beta, alpha, beta, gamma);
    // At theta=beta, exponent=0, so P = gamma + (1-gamma)/2 = (1+gamma)/2
    expect(p).toBeCloseTo((1 + gamma) / 2, 5);
  });

  test("probability(theta=-100) should approach gamma", () => {
    const p = probability(-100, 1.5, 0.0, 0.1);
    expect(p).toBeCloseTo(0.1, 5);
  });

  test("probability(theta=+100) should approach 1", () => {
    const p = probability(100, 1.5, 0.0, 0.1);
    expect(p).toBeCloseTo(1.0, 5);
  });

  test("probability with gamma=0 reduces to 2PL model", () => {
    const theta = 1.0;
    const alpha = 2.0;
    const beta = 0.5;
    const p = probability(theta, alpha, beta, 0);
    // 2PL: 1 / (1 + exp(-alpha*(theta-beta)))
    const expected2PL = 1 / (1 + Math.exp(-alpha * (theta - beta)));
    expect(p).toBeCloseTo(expected2PL, 10);
  });
});

describe("fisherInformation", () => {
  test("Fisher info is near max when theta = beta (gamma=0)", () => {
    const { item, theta, expected_info_approx } = expected.fisher_info_at_beta;
    const info = fisherInformation(theta, item.alpha, item.beta, item.gamma);
    // For gamma=0, I(beta) = alpha^2 * 0.5 * 0.5 = alpha^2/4
    // alpha=2 => 4/4 = 1.0
    expect(info).toBeCloseTo(expected_info_approx, 1);
  });

  test("Fisher info approaches 0 at extreme theta values", () => {
    const infoHigh = fisherInformation(5, 1.5, 0.0, 0.1);
    const infoLow = fisherInformation(-5, 1.5, 0.0, 0.1);
    expect(infoHigh).toBeLessThan(0.01);
    expect(infoLow).toBeLessThan(0.01);
  });

  test("Fisher info with gamma=0 reduces to alpha^2 * P * (1-P)", () => {
    const theta = 0.5;
    const alpha = 1.8;
    const beta = 0.3;
    const gamma = 0;
    const info = fisherInformation(theta, alpha, beta, gamma);
    const P = probability(theta, alpha, beta, gamma);
    const expectedInfo = alpha * alpha * P * (1 - P);
    expect(info).toBeCloseTo(expectedInfo, 10);
  });

  test("Fisher info with gamma>0 is reduced compared to gamma=0", () => {
    const theta = 0.0;
    const alpha = 2.0;
    const beta = 0.0;
    const infoNoGuess = fisherInformation(theta, alpha, beta, 0);
    const infoGuess = fisherInformation(theta, alpha, beta, 0.2);
    expect(infoGuess).toBeLessThan(infoNoGuess);
  });
});

describe("standardError", () => {
  test("SE decreases as more items are added", () => {
    const oneItem = typedItems.slice(0, 1);
    const threeItems = typedItems.slice(0, 3);
    const sixItems = typedItems.slice(0, 6);

    const se1 = standardError(0, oneItem);
    const se3 = standardError(0, threeItems);
    const se6 = standardError(0, sixItems);

    expect(se1).toBeGreaterThan(se3);
    expect(se3).toBeGreaterThan(se6);
  });
});

describe("normalizedScore", () => {
  test("normalizedScore(0) = 50", () => {
    expect(normalizedScore(0)).toBeCloseTo(50, 1);
  });

  test("normalizedScore(-3) close to 1", () => {
    const score = normalizedScore(-3);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(3);
  });

  test("normalizedScore(-1) close to 15", () => {
    const score = normalizedScore(-1);
    expect(score).toBeGreaterThan(10);
    expect(score).toBeLessThan(20);
  });

  test("normalizedScore(1) close to 85", () => {
    const score = normalizedScore(1);
    expect(score).toBeGreaterThan(80);
    expect(score).toBeLessThan(90);
  });

  test("normalizedScore(2) close to 97", () => {
    const score = normalizedScore(2);
    expect(score).toBeGreaterThan(95);
    expect(score).toBeLessThan(99);
  });

  test("normalizedScore(3) close to 99", () => {
    const score = normalizedScore(3);
    expect(score).toBeGreaterThan(98);
    expect(score).toBeLessThanOrEqual(100);
  });

  test("normalizedScore overflow protection (theta=+100)", () => {
    expect(normalizedScore(100)).toBe(100);
  });

  test("normalizedScore overflow protection (theta=-100)", () => {
    expect(normalizedScore(-100)).toBe(0);
  });
});

describe("logLikelihood", () => {
  test("logLikelihood is maximized near the correct theta for simulated data", () => {
    // Generate items centered around theta=1.0
    const testItems: IRTItem[] = [
      { id: "t1", alpha: 2.0, beta: -1.0, gamma: 0, dimension: "robustness" },
      { id: "t2", alpha: 2.0, beta: 0.0, gamma: 0, dimension: "robustness" },
      { id: "t3", alpha: 2.0, beta: 0.5, gamma: 0, dimension: "robustness" },
      { id: "t4", alpha: 2.0, beta: 1.0, gamma: 0, dimension: "robustness" },
      { id: "t5", alpha: 2.0, beta: 1.5, gamma: 0, dimension: "robustness" },
      { id: "t6", alpha: 2.0, beta: 2.0, gamma: 0, dimension: "robustness" },
    ];
    // Responses consistent with theta ~ 1.0
    // Items easier than 1.0 passed, harder failed
    const responses: (0 | 1)[] = [1, 1, 1, 1, 0, 0];

    // LL at correct range should be higher than at extremes
    const llAt1 = logLikelihood(1.0, testItems, responses);
    const llAtMinus3 = logLikelihood(-3.0, testItems, responses);
    const llAt3 = logLikelihood(3.0, testItems, responses);

    expect(llAt1).toBeGreaterThan(llAtMinus3);
    expect(llAt1).toBeGreaterThan(llAt3);
  });
});

describe("totalInformation", () => {
  test("totalInformation sums individual Fisher informations", () => {
    const theta = 0.5;
    const testItems = typedItems.slice(0, 3);
    const total = totalInformation(theta, testItems);
    const manual = testItems.reduce(
      (sum, item) => sum + fisherInformation(theta, item.alpha, item.beta, item.gamma),
      0,
    );
    expect(total).toBeCloseTo(manual, 10);
  });
});
