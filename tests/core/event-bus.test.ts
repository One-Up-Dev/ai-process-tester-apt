import { beforeEach, describe, expect, test } from "bun:test";
import { EventBus } from "@apt/core/event-bus";
import type { TargetConfig } from "@apt/lib/types";

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  test("on() + emit() calls handler with correct data", () => {
    const target: TargetConfig = {
      url: "http://localhost:3000",
      adapter: "http",
    };

    let received: { target: TargetConfig } | null = null;
    bus.on("introspector.started", (data) => {
      received = data;
    });

    bus.emit("introspector.started", { target });

    expect(received).not.toBeNull();
    const r = received as unknown as { target: TargetConfig };
    expect(r.target.url).toBe("http://localhost:3000");
    expect(r.target.adapter).toBe("http");
  });

  test("on() + emit() handler receives typed data", () => {
    bus.on("executor.test.completed", (data) => {
      // TypeScript would complain if these properties did not exist
      expect(data.test_id).toBe("test-1");
      expect(data.passed).toBe(true);
      expect(data.theta).toBe(1.5);
      expect(data.se).toBe(0.3);
      expect(data.dimension).toBe("robustness");
    });

    bus.emit("executor.test.completed", {
      test_id: "test-1",
      passed: true,
      theta: 1.5,
      se: 0.3,
      dimension: "robustness",
    });
  });

  test("off() removes handler so it is no longer called", () => {
    let callCount = 0;
    const handler = () => {
      callCount++;
    };

    bus.on("analyzer.started", handler);
    bus.emit("analyzer.started", {});
    expect(callCount).toBe(1);

    bus.off("analyzer.started", handler);
    bus.emit("analyzer.started", {});
    expect(callCount).toBe(1);
  });

  test("once() handler is called only once", () => {
    let callCount = 0;
    bus.once("mapper.standard.loaded", () => {
      callCount++;
    });

    bus.emit("mapper.standard.loaded", { standard: "eu-ai-act" });
    bus.emit("mapper.standard.loaded", { standard: "nist-rmf" });
    bus.emit("mapper.standard.loaded", { standard: "iso-42001" });

    expect(callCount).toBe(1);
  });

  test("multiple handlers on same event are all called", () => {
    const calls: string[] = [];

    bus.on("mapper.standard.loaded", () => calls.push("handler-1"));
    bus.on("mapper.standard.loaded", () => calls.push("handler-2"));
    bus.on("mapper.standard.loaded", () => calls.push("handler-3"));

    bus.emit("mapper.standard.loaded", { standard: "eu-ai-act" });

    expect(calls).toEqual(["handler-1", "handler-2", "handler-3"]);
  });

  test("onAny() wildcard receives all events", () => {
    const received: string[] = [];

    bus.onAny((event) => {
      received.push(event);
    });

    const target: TargetConfig = {
      url: "http://localhost:3000",
      adapter: "http",
    };
    bus.emit("introspector.started", { target });
    bus.emit("mapper.standard.loaded", { standard: "eu-ai-act" });

    expect(received).toEqual(["introspector.started", "mapper.standard.loaded"]);
  });

  test("removeAll(event) clears handlers for a specific event", () => {
    let introspectorCalls = 0;
    let mapperCalls = 0;

    bus.on("introspector.started", () => introspectorCalls++);
    bus.on("mapper.standard.loaded", () => mapperCalls++);

    bus.removeAll("introspector.started");

    bus.emit("introspector.started", {
      target: { url: "http://localhost", adapter: "http" as const },
    });
    bus.emit("mapper.standard.loaded", { standard: "eu-ai-act" });

    expect(introspectorCalls).toBe(0);
    expect(mapperCalls).toBe(1);
  });

  test("removeAll() without arg clears everything including wildcard handlers", () => {
    let specificCalls = 0;
    let wildcardCalls = 0;

    bus.on("mapper.standard.loaded", () => specificCalls++);
    bus.onAny(() => wildcardCalls++);

    bus.removeAll();

    bus.emit("mapper.standard.loaded", { standard: "eu-ai-act" });

    expect(specificCalls).toBe(0);
    expect(wildcardCalls).toBe(0);
  });

  test("listenerCount returns correct number", () => {
    expect(bus.listenerCount("introspector.started")).toBe(0);

    const h1 = () => {};
    const h2 = () => {};
    bus.on("introspector.started", h1);
    expect(bus.listenerCount("introspector.started")).toBe(1);

    bus.on("introspector.started", h2);
    expect(bus.listenerCount("introspector.started")).toBe(2);

    bus.off("introspector.started", h1);
    expect(bus.listenerCount("introspector.started")).toBe(1);
  });

  test("emit without handlers does not throw", () => {
    expect(() => {
      bus.emit("pipeline.failed", {
        error: {
          module: "test",
          severity: "error",
          code: "TEST",
          message: "test error",
          recoverable: false,
        },
      });
    }).not.toThrow();
  });

  test("offAny removes wildcard handler", () => {
    let callCount = 0;
    const handler = () => {
      callCount++;
    };

    bus.onAny(handler);
    bus.emit("mapper.standard.loaded", { standard: "eu-ai-act" });
    expect(callCount).toBe(1);

    bus.offAny(handler);
    bus.emit("mapper.standard.loaded", { standard: "nist" });
    expect(callCount).toBe(1);
  });
});
