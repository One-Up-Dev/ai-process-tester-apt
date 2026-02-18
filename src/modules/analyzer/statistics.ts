// === APT Analyzer — Statistics Functions ===
// Descriptive statistics, statistical tests, and scoring utilities.

// === DESCRIPTIVE STATISTICS ===

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function standardDeviation(values: number[]): number {
  if (values.length <= 1) return 0;
  const m = mean(values);
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// === STATISTICAL TESTS ===

export function welchTTest(
  group1: number[],
  group2: number[],
): { t: number; df: number; p: number } {
  const n1 = group1.length;
  const n2 = group2.length;
  const m1 = mean(group1);
  const m2 = mean(group2);
  const v1 = n1 > 1 ? group1.reduce((a, b) => a + (b - m1) ** 2, 0) / (n1 - 1) : 0;
  const v2 = n2 > 1 ? group2.reduce((a, b) => a + (b - m2) ** 2, 0) / (n2 - 1) : 0;

  const se = Math.sqrt(v1 / n1 + v2 / n2);
  if (se === 0) return { t: 0, df: n1 + n2 - 2, p: 1 };

  const t = (m1 - m2) / se;
  const df = (v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1));

  // Approximate p-value using normal distribution for large df
  const p = 2 * (1 - normalCDF(Math.abs(t)));
  return { t, df, p };
}

export function cohensD(group1: number[], group2: number[]): number {
  const m1 = mean(group1);
  const m2 = mean(group2);
  const n1 = group1.length;
  const n2 = group2.length;
  const v1 = n1 > 1 ? group1.reduce((a, b) => a + (b - m1) ** 2, 0) / (n1 - 1) : 0;
  const v2 = n2 > 1 ? group2.reduce((a, b) => a + (b - m2) ** 2, 0) / (n2 - 1) : 0;
  const pooledSD = Math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2));
  return pooledSD === 0 ? 0 : (m1 - m2) / pooledSD;
}

export function statisticalPower(effectSize: number, n1: number, n2: number, alpha = 0.05): number {
  const se = Math.sqrt(1 / n1 + 1 / n2);
  const ncp = effectSize / se; // non-centrality parameter
  const criticalValue = normalQuantile(1 - alpha / 2);
  // Power = P(ncp - z_alpha/2) + P(-ncp - z_alpha/2)
  return normalCDF(ncp - criticalValue) + normalCDF(-ncp - criticalValue);
}

// === SCORES AND GRADES ===

export function thetaToScore(theta: number): number {
  return 100 / (1 + Math.exp(-1.7 * theta));
}

export function scoreToGrade(score: number): string {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

export function overallScore(dimensionScores: number[]): number {
  if (dimensionScores.length === 0) return 0;
  // Equal-weight average
  return mean(dimensionScores);
}

// === HELPERS ===

// Normal CDF approximation (Abramowitz and Stegun)
function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * absX);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return 0.5 * (1 + sign * y);
}

// Normal quantile approximation (Beasley-Springer-Moro)
function normalQuantile(p: number): number {
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;
  if (p === 0.5) return 0;

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;
  let r: number;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(
    (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}
