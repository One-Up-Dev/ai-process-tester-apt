import type { Detector, ExecutionBackend } from "@apt/lib/types";

export class PluginRegistry {
  private detectors: Detector[] = [];
  private backends: Map<string, ExecutionBackend> = new Map();

  registerDetector(detector: Detector): void {
    this.detectors.push(detector);
    this.detectors.sort((a, b) => a.priority - b.priority);
  }

  registerBackend(backend: ExecutionBackend): void {
    this.backends.set(backend.id, backend);
  }

  getDetectors(): Detector[] {
    return [...this.detectors];
  }

  getBackends(): ExecutionBackend[] {
    return [...this.backends.values()];
  }

  getBackendById(id: string): ExecutionBackend | undefined {
    return this.backends.get(id);
  }
}
