import type { CATState, ConvergenceConfig, IRTItem, TestDimension } from "@apt/lib/types";
import { checkConvergence, getDefaultConfig } from "./convergence";
import { estimateTheta } from "./estimation";
import { normalizedScore } from "./model";
import { selectNextItem } from "./selection";

export class CATEngine {
  private items: IRTItem[];
  private dimension: TestDimension;
  private config: ConvergenceConfig;
  private state: CATState;
  private administeredIds: Set<string> = new Set();
  private convergenceTestNumber: number | null = null;

  constructor(items: IRTItem[], dimension: TestDimension, config?: Partial<ConvergenceConfig>) {
    this.items = items;
    this.dimension = dimension;
    this.config = { ...getDefaultConfig(), ...config };
    this.state = {
      theta: 0,
      se: Number.POSITIVE_INFINITY,
      responses: [],
      startTime: Date.now(),
      dimension,
    };
  }

  nextItem(): IRTItem | null {
    return selectNextItem(this.state.theta, this.items, this.administeredIds, this.dimension);
  }

  recordResponse(itemId: string, response: 0 | 1): { theta: number; se: number; method: string } {
    this.administeredIds.add(itemId);

    const administeredItems = this.items.filter((item) => this.administeredIds.has(item.id));
    const responses: (0 | 1)[] = [...this.state.responses.map((r) => r.response), response];

    const result = estimateTheta(administeredItems, responses);

    this.state.theta = result.theta;
    this.state.se = result.se;
    this.state.responses.push({
      itemId,
      response,
      theta: result.theta,
      se: result.se,
      timestamp: Date.now(),
    });

    // Check convergence and record the test number
    if (this.convergenceTestNumber === null) {
      const conv = checkConvergence(this.state, this.config);
      if (conv.converged) {
        this.convergenceTestNumber = this.state.responses.length;
      }
    }

    return { theta: result.theta, se: result.se, method: result.method };
  }

  isConverged(): { converged: boolean; reason?: string } {
    return checkConvergence(this.state, this.config);
  }

  getState(): CATState {
    return { ...this.state };
  }

  getResults(): {
    theta: number;
    se: number;
    ciLower: number;
    ciUpper: number;
    normalizedScore: number;
    nTests: number;
    convergenceTestNumber: number | null;
    dimension: TestDimension;
  } {
    const ci = 1.96 * this.state.se;
    return {
      theta: this.state.theta,
      se: this.state.se,
      ciLower: this.state.theta - ci,
      ciUpper: this.state.theta + ci,
      normalizedScore: normalizedScore(this.state.theta),
      nTests: this.state.responses.length,
      convergenceTestNumber: this.convergenceTestNumber,
      dimension: this.dimension,
    };
  }
}

// Re-export sub-modules
export {
  probability,
  fisherInformation,
  normalizedScore,
  standardError,
  logLikelihood,
  totalInformation,
} from "./model";
export { estimateTheta, estimateThetaMLE, estimateThetaEAP } from "./estimation";
export {
  selectNextItem,
  rankItemsByInformation,
  filterItemsByDimension,
} from "./selection";
export { checkConvergence, getDefaultConfig } from "./convergence";
