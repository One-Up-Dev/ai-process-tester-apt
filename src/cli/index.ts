import { defineCommand, runMain } from "citty";

const main = defineCommand({
  meta: {
    name: "apt",
    version: "0.0.1",
    description: "AI Process Tester — Adaptive evaluation for AI systems using IRT",
  },
  subCommands: {
    init: () => import("./commands/init").then((m) => m.default),
    run: () => import("./commands/run").then((m) => m.default),
    report: () => import("./commands/report").then((m) => m.default),
    introspect: () => import("./commands/introspect").then((m) => m.default),
    export: () => import("./commands/export").then((m) => m.default),
  },
});

runMain(main);
