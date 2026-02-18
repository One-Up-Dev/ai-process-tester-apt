import type { CATState, ConvergenceConfig } from "@apt/lib/types";

interface ConvergenceResult {
  converged: boolean;
  reason?: string;
}

export function getDefaultConfig(): ConvergenceConfig {
  return {
    seThreshold: 0.3,
    maxTests: 100,
    timeoutMs: 30 * 60 * 1000, // 30 minutes
    stableWindow: 5,
    stableDelta: 0.1,
  };
}

/** Check all 4 convergence criteria */
export function checkConvergence(state: CATState, config: ConvergenceConfig): ConvergenceResult {
  if (state.responses.length === 0) {
    return { converged: false };
  }

  // 1. SE below threshold
  if (state.se < config.seThreshold) {
    return {
      converged: true,
      reason: `SE (${state.se.toFixed(3)}) < threshold (${config.seThreshold})`,
    };
  }

  // 2. Max tests reached
  if (state.responses.length >= config.maxTests) {
    return {
      converged: true,
      reason: `Max tests reached (${config.maxTests})`,
    };
  }

  // 3. Timeout
  const elapsed = Date.now() - state.startTime;
  if (elapsed >= config.timeoutMs) {
    return {
      converged: true,
      reason: `Timeout (${config.timeoutMs}ms)`,
    };
  }

  // 4. Stable window: |delta_theta| < stableDelta for last stableWindow tests
  if (state.responses.length >= config.stableWindow) {
    const recent = state.responses.slice(-config.stableWindow);
    const allStable = recent.every((r, i) => {
      if (i === 0) return true;
      return Math.abs(r.theta - recent[i - 1].theta) < config.stableDelta;
    });
    if (allStable) {
      return {
        converged: true,
        reason: `Theta stable over ${config.stableWindow} tests (delta < ${config.stableDelta})`,
      };
    }
  }

  return { converged: false };
}
