import type {
  AnalysisReport,
  ExecutionResults,
  ModuleError,
  PipelineConfig,
  SystemProfile,
  TargetConfig,
  TestDimension,
  TestPlan,
} from "@apt/lib/types";

// Typed event map
export interface APTEventMap {
  "pipeline.started": { config: PipelineConfig };
  "pipeline.completed": { report: AnalysisReport; duration_ms: number };
  "pipeline.failed": { error: ModuleError };
  "introspector.started": { target: TargetConfig };
  "introspector.completed": { profile: SystemProfile };
  "mapper.standard.loaded": { standard: string };
  "mapper.gap.detected": { requirement: string; criticality: string };
  "generator.test.selected": { test_id: string; dimension: TestDimension };
  "executor.started": { plan: TestPlan };
  "executor.test.started": { test_id: string; dimension: TestDimension };
  "executor.test.completed": {
    test_id: string;
    passed: boolean;
    theta: number;
    se: number;
    dimension: TestDimension;
  };
  "executor.irt.updated": {
    dimension: TestDimension;
    theta: number;
    se: number;
    n_tests: number;
  };
  "executor.dimension.converged": {
    dimension: TestDimension;
    theta: number;
    se: number;
    reason: string;
  };
  "executor.completed": { results: ExecutionResults };
  "analyzer.started": Record<string, never>;
  "analyzer.report.generated": { format: string; path: string };
  "analyzer.completed": { report: AnalysisReport };
  "introspector.baseline.progress": {
    current: number;
    total: number;
    phase: "warmup" | "measure";
  };
  "executor.warmup.progress": { current: number; total: number };
  "generator.completed": {
    total_tests: number;
    dimensions: string[];
    estimated_tests: number;
  };
}

type EventHandler<T> = (data: T) => void;
type AnyHandler = (event: string, data: unknown) => void;

export class EventBus {
  private handlers = new Map<string, Set<EventHandler<unknown>>>();
  private anyHandlers = new Set<AnyHandler>();

  on<K extends keyof APTEventMap>(event: K, handler: EventHandler<APTEventMap[K]>): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)?.add(handler as EventHandler<unknown>);
  }

  off<K extends keyof APTEventMap>(event: K, handler: EventHandler<APTEventMap[K]>): void {
    const set = this.handlers.get(event);
    if (set) {
      set.delete(handler as EventHandler<unknown>);
    }
  }

  once<K extends keyof APTEventMap>(event: K, handler: EventHandler<APTEventMap[K]>): void {
    const wrapper = ((data: APTEventMap[K]) => {
      handler(data);
      this.off(event, wrapper);
    }) as EventHandler<APTEventMap[K]>;
    this.on(event, wrapper);
  }

  emit<K extends keyof APTEventMap>(event: K, data: APTEventMap[K]): void {
    const set = this.handlers.get(event);
    if (set) {
      for (const handler of set) {
        handler(data);
      }
    }
    for (const handler of this.anyHandlers) {
      handler(event, data);
    }
  }

  onAny(handler: AnyHandler): void {
    this.anyHandlers.add(handler);
  }

  offAny(handler: AnyHandler): void {
    this.anyHandlers.delete(handler);
  }

  removeAll(event?: string): void {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
      this.anyHandlers.clear();
    }
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

export const eventBus = new EventBus();
