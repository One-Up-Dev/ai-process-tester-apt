import { describe, expect, test } from "bun:test";
import {
  cohensD,
  mean,
  median,
  overallScore,
  percentile,
  scoreToGrade,
  standardDeviation,
  statisticalPower,
  welchTTest,
} from "@apt/modules/analyzer/statistics";

describe("Statistics — Descriptive", () => {
  test("mean of [1,2,3,4,5] = 3", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });

  test("mean of empty array = 0", () => {
    expect(mean([])).toBe(0);
  });

  test("median of odd-length array", () => {
    // [1, 2, 3, 4, 5] -> median = 3
    expect(median([5, 1, 3, 4, 2])).toBe(3);
  });

  test("median of even-length array", () => {
    // [1, 2, 3, 4] -> median = 2.5
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test("percentile — p50 and p95", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const p50 = percentile(values, 50);
    const p95 = percentile(values, 95);
    // p50 of 1..100 = 50.5
    expect(p50).toBeCloseTo(50.5, 1);
    // p95 of 1..100 = 95.05
    expect(p95).toBeCloseTo(95.05, 1);
  });

  test("standardDeviation of known values", () => {
    // Sample std dev of [2, 4, 4, 4, 5, 5, 7, 9] = 2.138...
    const sd = standardDeviation([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(sd).toBeCloseTo(2.138, 2);
  });
});

describe("Statistics — Statistical Tests", () => {
  test("welchTTest — different means yield t > 0 and p < 0.05", () => {
    // Group 1: mean ~100, Group 2: mean ~80
    const group1 = [95, 100, 105, 98, 102, 99, 101, 97, 103, 100];
    const group2 = [75, 80, 85, 78, 82, 79, 81, 77, 83, 80];

    const result = welchTTest(group1, group2);
    expect(result.t).toBeGreaterThan(0);
    expect(result.p).toBeLessThan(0.05);
    expect(result.df).toBeGreaterThan(0);
  });

  test("cohensD — large effect size for very different groups", () => {
    // Group 1: mean ~100 (sd ~3), Group 2: mean ~80 (sd ~3)
    const group1 = [98, 100, 102, 99, 101, 97, 103, 100, 98, 102];
    const group2 = [78, 80, 82, 79, 81, 77, 83, 80, 78, 82];

    const d = cohensD(group1, group2);
    // Effect size should be very large (> 0.8)
    expect(Math.abs(d)).toBeGreaterThan(0.8);
  });

  test("statisticalPower — high power for large effect and large n", () => {
    // Large effect size (d=1.0), n=50 per group
    const power = statisticalPower(1.0, 50, 50);
    // Should have very high power (> 0.9)
    expect(power).toBeGreaterThan(0.9);
  });
});

describe("Statistics — Scores and Grades", () => {
  test("overallScore + scoreToGrade — all grade boundaries", () => {
    // Grade A: score >= 85
    expect(scoreToGrade(90)).toBe("A");
    expect(scoreToGrade(85)).toBe("A");

    // Grade B: score >= 70
    expect(scoreToGrade(75)).toBe("B");
    expect(scoreToGrade(70)).toBe("B");

    // Grade C: score >= 55
    expect(scoreToGrade(60)).toBe("C");
    expect(scoreToGrade(55)).toBe("C");

    // Grade D: score >= 40
    expect(scoreToGrade(45)).toBe("D");
    expect(scoreToGrade(40)).toBe("D");

    // Grade F: score < 40
    expect(scoreToGrade(30)).toBe("F");
    expect(scoreToGrade(0)).toBe("F");

    // overallScore is the mean
    const overall = overallScore([90, 70, 50]);
    expect(overall).toBeCloseTo(70, 1);
    expect(scoreToGrade(overall)).toBe("B");
  });
});
