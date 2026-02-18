import type { IRTItem, TestDimension } from "@apt/lib/types";
import { fisherInformation } from "./model";

/** Select the most informative item for the current theta and dimension */
export function selectNextItem(
  theta: number,
  availableItems: IRTItem[],
  administeredIds: Set<string>,
  dimension: TestDimension,
): IRTItem | null {
  const candidates = availableItems.filter(
    (item) => item.dimension === dimension && !administeredIds.has(item.id),
  );

  if (candidates.length === 0) return null;

  let bestItem: IRTItem | null = null;
  let bestInfo = Number.NEGATIVE_INFINITY;

  for (const item of candidates) {
    let info = fisherInformation(theta, item.alpha, item.beta, item.gamma);
    // Preliminary items: 50% reduction in information weight
    if (item.is_preliminary) {
      info *= 0.5;
    }
    if (info > bestInfo) {
      bestInfo = info;
      bestItem = item;
    }
  }

  return bestItem;
}

/** Rank items by Fisher Information (descending) */
export function rankItemsByInformation(theta: number, items: IRTItem[]): IRTItem[] {
  return [...items].sort((a, b) => {
    const infoA = fisherInformation(theta, a.alpha, a.beta, a.gamma);
    const infoB = fisherInformation(theta, b.alpha, b.beta, b.gamma);
    return infoB - infoA;
  });
}

/** Filter items by dimension */
export function filterItemsByDimension(items: IRTItem[], dimension: TestDimension): IRTItem[] {
  return items.filter((item) => item.dimension === dimension);
}
