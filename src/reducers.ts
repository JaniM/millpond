import type { Reducer } from "./aggregate";

/** Counts rows. O(1) per change. */
export const count: Reducer<unknown, number> = {
  init: () => 0,
  add: (acc) => acc + 1,
  remove: (acc) => acc - 1,
};

/** Sums numeric values. O(1) per change. */
export const sum: Reducer<number, number> = {
  init: () => 0,
  add: (acc, value) => acc + value,
  remove: (acc, value) => acc - value,
};

/** Index of the first element not less than `value` in a sorted array. */
function lowerBound(arr: readonly number[], value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const cur = arr[mid];
    if (cur !== undefined && cur < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function sortedInsert(arr: number[], value: number): void {
  arr.splice(lowerBound(arr, value), 0, value);
}

function sortedRemove(arr: number[], value: number): void {
  const i = lowerBound(arr, value);
  if (arr[i] === value) arr.splice(i, 1);
}

/**
 * Smallest value in the group, or `undefined` when empty. Keeps every child's
 * value in a sorted array, so O(log n) per change and O(n) memory.
 */
export const min: Reducer<number, number[], number | undefined> = {
  init: () => [],
  add: (acc, value) => {
    sortedInsert(acc, value);
    return acc;
  },
  remove: (acc, value) => {
    sortedRemove(acc, value);
    return acc;
  },
  result: (acc) => acc[0],
};

/** Largest value in the group, or `undefined` when empty. See `min`. */
export const max: Reducer<number, number[], number | undefined> = {
  init: () => [],
  add: (acc, value) => {
    sortedInsert(acc, value);
    return acc;
  },
  remove: (acc, value) => {
    sortedRemove(acc, value);
    return acc;
  },
  result: (acc) => acc[acc.length - 1],
};
