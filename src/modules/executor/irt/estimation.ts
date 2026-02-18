import type { IRTItem } from "@apt/lib/types";
import { fisherInformation, logLikelihood, probability } from "./model";

interface EstimationResult {
  theta: number;
  se: number;
  method: "mle" | "eap";
  converged: boolean;
}

interface EstimationOptions {
  maxIterations?: number;
  tolerance?: number;
  thetaMin?: number;
  thetaMax?: number;
}

const DEFAULTS = {
  maxIterations: 100,
  tolerance: 0.001,
  thetaMin: -4,
  thetaMax: 4,
};

/** MLE via Newton-Raphson with step-halving */
export function estimateThetaMLE(
  items: IRTItem[],
  responses: (0 | 1)[],
  opts?: EstimationOptions,
): EstimationResult {
  const { maxIterations, tolerance, thetaMin, thetaMax } = {
    ...DEFAULTS,
    ...opts,
  };
  let theta = 0;
  let converged = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    // First derivative of log-likelihood
    let dLL = 0;
    let d2LL = 0;

    for (let i = 0; i < items.length; i++) {
      const { alpha, beta, gamma } = items[i];
      const P = probability(theta, alpha, beta, gamma);
      const clampedP = Math.max(1e-10, Math.min(1 - 1e-10, P));
      const Pstar = (P - gamma) / (1 - gamma);
      const w = Pstar / clampedP;

      dLL += alpha * w * (responses[i] - P);
      // Using observed information (negative second derivative)
      const info = fisherInformation(theta, alpha, beta, gamma);
      d2LL -= info;
    }

    if (Math.abs(d2LL) < 1e-10) break;

    const step = -dLL / d2LL;
    // Step-halving if step is too large
    let stepSize = 1;
    for (let h = 0; h < 10; h++) {
      const newTheta = Math.max(thetaMin, Math.min(thetaMax, theta + stepSize * step));
      const newLL = logLikelihood(newTheta, items, responses);
      const oldLL = logLikelihood(theta, items, responses);
      if (newLL >= oldLL - 1e-10) {
        theta = newTheta;
        break;
      }
      stepSize *= 0.5;
      if (h === 9) {
        theta = Math.max(thetaMin, Math.min(thetaMax, theta + stepSize * step));
      }
    }

    if (Math.abs(stepSize * step) < tolerance) {
      converged = true;
      break;
    }
  }

  theta = Math.max(thetaMin, Math.min(thetaMax, theta));
  const totalInfo = items.reduce(
    (sum, item) => sum + fisherInformation(theta, item.alpha, item.beta, item.gamma),
    0,
  );
  const se = totalInfo > 0 ? 1 / Math.sqrt(totalInfo) : Number.POSITIVE_INFINITY;

  return { theta, se, method: "mle", converged };
}

/** EAP estimation with numerical integration */
export function estimateThetaEAP(
  items: IRTItem[],
  responses: (0 | 1)[],
  opts?: EstimationOptions,
): EstimationResult {
  const { thetaMin, thetaMax } = { ...DEFAULTS, ...opts };
  const nPoints = 41;
  const step = (thetaMax - thetaMin) / (nPoints - 1);

  let numerator = 0;
  let denominator = 0;
  let variance = 0;

  for (let i = 0; i < nPoints; i++) {
    const t = thetaMin + i * step;
    // Prior: N(0, 1)
    const prior = Math.exp((-t * t) / 2) / Math.sqrt(2 * Math.PI);
    // Likelihood
    let logL = 0;
    for (let j = 0; j < items.length; j++) {
      const p = probability(t, items[j].alpha, items[j].beta, items[j].gamma);
      const clampedP = Math.max(1e-10, Math.min(1 - 1e-10, p));
      logL += responses[j] === 1 ? Math.log(clampedP) : Math.log(1 - clampedP);
    }
    const likelihood = Math.exp(logL);
    const weight = likelihood * prior * step;

    numerator += t * weight;
    denominator += weight;
  }

  const theta = denominator > 0 ? numerator / denominator : 0;

  // Compute posterior variance for SE
  for (let i = 0; i < nPoints; i++) {
    const t = thetaMin + i * step;
    const prior = Math.exp((-t * t) / 2) / Math.sqrt(2 * Math.PI);
    let logL = 0;
    for (let j = 0; j < items.length; j++) {
      const p = probability(t, items[j].alpha, items[j].beta, items[j].gamma);
      const clampedP = Math.max(1e-10, Math.min(1 - 1e-10, p));
      logL += responses[j] === 1 ? Math.log(clampedP) : Math.log(1 - clampedP);
    }
    const likelihood = Math.exp(logL);
    const weight = likelihood * prior * step;
    variance += (t - theta) * (t - theta) * weight;
  }

  const se = denominator > 0 ? Math.sqrt(variance / denominator) : 1;

  return { theta, se, method: "eap", converged: true };
}

/** Facade with switching strategy:
 * 1. < 3 responses -> EAP
 * 2. All same response -> EAP
 * 3. Otherwise -> MLE, fallback EAP if MLE doesn't converge
 */
export function estimateTheta(
  items: IRTItem[],
  responses: (0 | 1)[],
  opts?: EstimationOptions,
): EstimationResult {
  if (responses.length < 3) return estimateThetaEAP(items, responses, opts);
  const allSame = responses.every((r) => r === responses[0]);
  if (allSame) return estimateThetaEAP(items, responses, opts);

  const mleResult = estimateThetaMLE(items, responses, opts);
  if (mleResult.converged) return mleResult;
  return estimateThetaEAP(items, responses, opts);
}
