import { describe, expect, it } from "vitest";
import { createDb, feature, op, table, VERSION } from "../src/index";

// The engine is not implemented yet: the public API is fully typed and
// exported, but the factories throw until the engine lands. These tests pin
// that contract so the surface stays stable while the internals fill in.
describe("scaffold surface", () => {
  it("exposes a version", () => {
    expect(VERSION).toBe("0.0.0");
  });

  it.each([
    ["createDb", () => createDb({ features: {} })],
    ["op", () => op(() => {})],
    ["feature", () => feature({})],
    ["table", () => (table as (...a: unknown[]) => unknown)({}, { key: "id" })],
  ])("%s throws a not-implemented error", (_name, call) => {
    expect(call).toThrow(/not implemented yet/);
  });
});
