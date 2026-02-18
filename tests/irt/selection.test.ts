import { describe, expect, test } from "bun:test";
import type { IRTItem } from "@apt/lib/types";
import { fisherInformation } from "@apt/modules/executor/irt/model";
import {
  filterItemsByDimension,
  rankItemsByInformation,
  selectNextItem,
} from "@apt/modules/executor/irt/selection";

import fixtureItems from "../fixtures/irt-items.json";

const items = fixtureItems as IRTItem[];

describe("selectNextItem", () => {
  test("selects the most informative item at current theta", () => {
    const theta = 0.0;
    const administered = new Set<string>();
    const selected = selectNextItem(theta, items, administered, "robustness");

    expect(selected).not.toBeNull();
    // Verify it's the item with max Fisher info among robustness items
    const robustnessItems = items.filter((i) => i.dimension === "robustness");
    let maxInfo = Number.NEGATIVE_INFINITY;
    let bestId = "";
    for (const item of robustnessItems) {
      const info = fisherInformation(theta, item.alpha, item.beta, item.gamma);
      if (info > maxInfo) {
        maxInfo = info;
        bestId = item.id;
      }
    }
    expect(selected?.id).toBe(bestId);
  });

  test("never selects already administered items", () => {
    const theta = 0.0;
    const administered = new Set<string>(["item-02", "item-05"]);
    const selected = selectNextItem(theta, items, administered, "robustness");

    expect(selected).not.toBeNull();
    expect(selected?.id).not.toBe("item-02");
    expect(selected?.id).not.toBe("item-05");
  });

  test("returns null when no items available for dimension", () => {
    const theta = 0.0;
    const administered = new Set<string>();
    const selected = selectNextItem(theta, items, administered, "compliance");
    expect(selected).toBeNull();
  });

  test("filters correctly by dimension", () => {
    const theta = 0.0;
    const administered = new Set<string>();
    const selected = selectNextItem(theta, items, administered, "security");
    expect(selected).not.toBeNull();
    expect(selected?.dimension).toBe("security");
  });

  test("preliminary items are downweighted vs calibrated", () => {
    const prelimItem: IRTItem = {
      id: "prelim-1",
      alpha: 2.5,
      beta: 0.0,
      gamma: 0.0,
      dimension: "robustness",
      is_preliminary: true,
    };
    const calibratedItem: IRTItem = {
      id: "calib-1",
      alpha: 2.0,
      beta: 0.0,
      gamma: 0.0,
      dimension: "robustness",
      is_preliminary: false,
    };

    // Without downweighting, prelim would have more info (higher alpha)
    const infoPrelim = fisherInformation(0, 2.5, 0, 0);
    const infoCalib = fisherInformation(0, 2.0, 0, 0);
    expect(infoPrelim).toBeGreaterThan(infoCalib);

    // But with downweighting (50%), calibrated should win
    const selected = selectNextItem(0, [prelimItem, calibratedItem], new Set(), "robustness");
    expect(selected?.id).toBe("calib-1");
  });

  test("higher alpha preferred when beta is equal", () => {
    const lowAlpha: IRTItem = {
      id: "low-a",
      alpha: 0.5,
      beta: 0.0,
      gamma: 0,
      dimension: "robustness",
    };
    const highAlpha: IRTItem = {
      id: "high-a",
      alpha: 2.5,
      beta: 0.0,
      gamma: 0,
      dimension: "robustness",
    };
    const selected = selectNextItem(0, [lowAlpha, highAlpha], new Set(), "robustness");
    expect(selected?.id).toBe("high-a");
  });

  test("selection is deterministic", () => {
    const theta = 0.5;
    const administered = new Set<string>();
    const first = selectNextItem(theta, items, administered, "robustness");
    const second = selectNextItem(theta, items, administered, "robustness");
    expect(first?.id).toBe(second?.id);
  });

  test("items of different dimension are ignored", () => {
    const securityItems = items.filter((i) => i.dimension === "security");
    const theta = 0.0;
    const selected = selectNextItem(theta, securityItems, new Set(), "robustness");
    expect(selected).toBeNull();
  });

  test("large pool (100 items) selects in < 10ms", () => {
    const largePool: IRTItem[] = [];
    for (let i = 0; i < 100; i++) {
      largePool.push({
        id: `large-${i}`,
        alpha: 0.5 + Math.random() * 2,
        beta: -3 + Math.random() * 6,
        gamma: Math.random() * 0.15,
        dimension: "robustness",
      });
    }
    const start = performance.now();
    const selected = selectNextItem(0, largePool, new Set(), "robustness");
    const elapsed = performance.now() - start;
    expect(selected).not.toBeNull();
    expect(elapsed).toBeLessThan(10);
  });
});

describe("rankItemsByInformation", () => {
  test("returns items sorted by descending Fisher info", () => {
    const theta = 0.0;
    const robustness = items.filter((i) => i.dimension === "robustness");
    const ranked = rankItemsByInformation(theta, robustness);

    for (let i = 0; i < ranked.length - 1; i++) {
      const infoA = fisherInformation(theta, ranked[i].alpha, ranked[i].beta, ranked[i].gamma);
      const infoB = fisherInformation(
        theta,
        ranked[i + 1].alpha,
        ranked[i + 1].beta,
        ranked[i + 1].gamma,
      );
      expect(infoA).toBeGreaterThanOrEqual(infoB);
    }
  });
});

describe("filterItemsByDimension", () => {
  test("filters correctly", () => {
    const security = filterItemsByDimension(items, "security");
    expect(security.length).toBe(2);
    expect(security.every((i) => i.dimension === "security")).toBe(true);
  });
});
