import { mkdir } from "node:fs/promises";
import { closeDatabase, getDatabase } from "@apt/lib/db";
import { runMigrations } from "@apt/lib/migrations";
import { EvaluationRepository, type EvaluationRow } from "@apt/lib/repositories/evaluations";
import { IRTEstimateRepository } from "@apt/lib/repositories/irt-estimates";
import { TestResultRepository } from "@apt/lib/repositories/test-results";
import { EXIT_CODES } from "@apt/lib/types";
import { defineCommand } from "citty";
import { consola } from "consola";

export default defineCommand({
  meta: { name: "export", version: "0.0.1", description: "Export evaluation data" },
  args: {
    evaluation: { type: "string", description: "Evaluation ID (exports all if omitted)" },
    format: { type: "string", default: "csv", description: "Export format: csv | json" },
    output: { type: "string", default: "./apt-exports", description: "Output directory" },
  },
  async run({ args }) {
    try {
      const db = getDatabase();
      runMigrations(db);

      const evaluations = new EvaluationRepository(db);
      const testResults = new TestResultRepository(db);
      const irtEstimates = new IRTEstimateRepository(db);

      await mkdir(args.output, { recursive: true });

      // Get evaluations
      let evals: EvaluationRow[];
      if (args.evaluation) {
        const ev = evaluations.findById(args.evaluation);
        evals = ev ? [ev] : [];
      } else {
        evals = evaluations.findRecent(100);
      }

      if (evals.length === 0) {
        consola.warn("No evaluations found");
        closeDatabase();
        process.exit(EXIT_CODES.ERROR);
      }

      for (const ev of evals) {
        const results = testResults.findByEvaluation(ev.id);
        const estimates = irtEstimates.findByEvaluation(ev.id);

        if (args.format === "json") {
          const data = { evaluation: ev, test_results: results, irt_estimates: estimates };
          const path = `${args.output}/export_${ev.id}.json`;
          await Bun.write(path, JSON.stringify(data, null, 2));
          consola.success(`Exported: ${path}`);
        } else {
          // CSV
          if (results.length > 0) {
            const headers = Object.keys(results[0]).join(",");
            const rows = results.map((r) =>
              Object.values(r)
                .map((v) => JSON.stringify(v ?? ""))
                .join(","),
            );
            const csv = [headers, ...rows].join("\n");
            const path = `${args.output}/results_${ev.id}.csv`;
            await Bun.write(path, csv);
            consola.success(`Exported: ${path}`);
          }

          if (estimates.length > 0) {
            const headers = Object.keys(estimates[0]).join(",");
            const rows = estimates.map((e) =>
              Object.values(e)
                .map((v) => JSON.stringify(v ?? ""))
                .join(","),
            );
            const csv = [headers, ...rows].join("\n");
            const path = `${args.output}/irt_${ev.id}.csv`;
            await Bun.write(path, csv);
            consola.success(`Exported: ${path}`);
          }
        }
      }

      closeDatabase();
    } catch (err) {
      consola.error("Export failed:", err instanceof Error ? err.message : String(err));
      closeDatabase();
      process.exit(EXIT_CODES.ERROR);
    }
  },
});
