import { consola } from "consola";
import { eventBus } from "./event-bus";

// Debug: log all events
eventBus.onAny((event, data) => consola.debug(`[event] ${event}`, data));

// Info: user-facing events
eventBus.on("executor.test.completed", (data) => {
  consola.info(
    `[${data.dimension}] ${data.test_id}: ${data.passed ? "PASS" : "FAIL"} | \u03B8=${data.theta.toFixed(2)} | SE=${data.se.toFixed(2)}`,
  );
});

eventBus.on("executor.dimension.converged", (data) => {
  consola.success(
    `[${data.dimension}] Converged! \u03B8=${data.theta.toFixed(2)} SE=${data.se.toFixed(2)} (${data.reason})`,
  );
});

eventBus.on("pipeline.failed", (data) => {
  consola.error(`[${data.error.module}] ${data.error.message}`);
});

export { consola as logger };
