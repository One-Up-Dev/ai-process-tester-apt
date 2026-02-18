// === APT JSON Reporter ===
// Generates a structured JSON report file from an AnalysisReport.

import { mkdir } from "node:fs/promises";
import type { AnalysisReport } from "@apt/lib/types";

export class JsonReporter {
  async generate(report: AnalysisReport, outputDir: string): Promise<string> {
    const path = `${outputDir}/evaluation_${report.evaluation_id}.json`;
    await mkdir(outputDir, { recursive: true });
    await Bun.write(path, JSON.stringify(report, null, 2));
    return path;
  }
}
