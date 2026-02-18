import { defineCommand } from "citty";
import { consola } from "consola";

export default defineCommand({
  meta: {
    name: "compare",
    version: "0.0.1",
    description: "Compare results between evaluation runs",
  },
  args: {},
  run() {
    consola.warn("Not yet implemented (Phase 1)");
    process.exit(2);
  },
});
