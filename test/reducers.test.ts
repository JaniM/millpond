import { describe, expect, it } from "vitest";
import { count, max, min, sum } from "../src/index";

describe("count", () => {
  it("tracks group size across add and remove", () => {
    let acc = count.init();
    acc = count.add(acc, "a");
    acc = count.add(acc, "b");
    acc = count.remove(acc, "a");
    expect(acc).toBe(1);
  });
});

describe("sum", () => {
  it("adds and removes numeric values", () => {
    let acc = sum.init();
    acc = sum.add(acc, 10);
    acc = sum.add(acc, 5);
    acc = sum.remove(acc, 10);
    expect(acc).toBe(5);
  });
});

describe("min / max", () => {
  const result = <T>(r: { result?: (acc: T) => unknown }, acc: T) =>
    r.result ? r.result(acc) : acc;

  it("return undefined for an empty group", () => {
    expect(result(min, min.init())).toBeUndefined();
    expect(result(max, max.init())).toBeUndefined();
  });

  it("track the extremes as values come and go", () => {
    let lo = min.init();
    let hi = max.init();
    for (const v of [3, 1, 4, 1, 5]) {
      lo = min.add(lo, v);
      hi = max.add(hi, v);
    }
    expect(result(min, lo)).toBe(1);
    expect(result(max, hi)).toBe(5);

    // Removing one of the two 1s keeps the min at 1.
    lo = min.remove(lo, 1);
    expect(result(min, lo)).toBe(1);

    // Removing the top exposes the next largest.
    hi = max.remove(hi, 5);
    expect(result(max, hi)).toBe(4);
  });
});
