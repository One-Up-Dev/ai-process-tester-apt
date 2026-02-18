import type { IRTItem } from "@apt/lib/types";

/** ICC: gamma + (1-gamma) / (1 + exp(-alpha*(theta-beta))) */
export function probability(theta: number, alpha: number, beta: number, gamma: number): number {
  const exponent = -alpha * (theta - beta);
  // Overflow protection
  if (exponent > 500) return gamma;
  if (exponent < -500) return 1;
  return gamma + (1 - gamma) / (1 + Math.exp(exponent));
}

/** Fisher Information for 2PL+guessing model (CORRECT formula)
 * P*(theta) = (P(theta) - gamma) / (1 - gamma)
 * I(theta) = alpha^2 * (P*^2 / P) * (1 - P)
 * When gamma=0: reduces to alpha^2 * P * (1-P)
 */
export function fisherInformation(
  theta: number,
  alpha: number,
  beta: number,
  gamma: number,
): number {
  const P = probability(theta, alpha, beta, gamma);
  if (P <= gamma || P >= 1) return 0;
  const Pstar = (P - gamma) / (1 - gamma);
  return alpha * alpha * ((Pstar * Pstar) / P) * (1 - P);
}

/** Total information for a set of items at theta */
export function totalInformation(theta: number, items: IRTItem[]): number {
  return items.reduce(
    (sum, item) => sum + fisherInformation(theta, item.alpha, item.beta, item.gamma),
    0,
  );
}

/** Standard error: 1 / sqrt(totalInformation) */
export function standardError(theta: number, items: IRTItem[]): number {
  const info = totalInformation(theta, items);
  if (info <= 0) return Number.POSITIVE_INFINITY;
  return 1 / Math.sqrt(info);
}

/** Normalized score: 100 / (1 + exp(-1.7 * theta)) with overflow protection */
export function normalizedScore(theta: number): number {
  const exponent = -1.7 * theta;
  if (exponent > 100) return 0;
  if (exponent < -100) return 100;
  return 100 / (1 + Math.exp(exponent));
}

/** Log-likelihood of theta given items and responses */
export function logLikelihood(theta: number, items: IRTItem[], responses: (0 | 1)[]): number {
  let ll = 0;
  for (let i = 0; i < items.length; i++) {
    const p = probability(theta, items[i].alpha, items[i].beta, items[i].gamma);
    const clampedP = Math.max(1e-10, Math.min(1 - 1e-10, p));
    if (responses[i] === 1) {
      ll += Math.log(clampedP);
    } else {
      ll += Math.log(1 - clampedP);
    }
  }
  return ll;
}
