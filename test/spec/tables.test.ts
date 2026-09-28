import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDb, feature, op, type Query, type Table, table } from "../../src/index";
import { expectDeliberate, expectThrows, flush, spec, track } from "./harness";

// Spec §"Tables and schemas".

// Build a one-table db with the given schema/options and generic write ops.
// `lastKey()` exposes the key returned by the most recent `tx.insert`, since
// ops themselves return nothing to the caller.
// Rows are loosely typed: these tests deliberately write rows the schema rejects.
type LooseRow = Record<string, unknown>;
type LooseTable = Table<LooseRow, unknown> & {
  all(): Query<LooseRow, readonly LooseRow[]>;
  get(key: unknown): Query<LooseRow, LooseRow | undefined>;
};

function bench(schema: z.ZodTypeAny, options: object, flags: object = {}) {
  const t = table(schema as never, options as never) as unknown as LooseTable;
  let lastKey: unknown;
  const insert = op((tx, row: unknown) => {
    lastKey = tx.insert(t, row as never);
  });
  const update = op((tx, a: { key: unknown; patch: unknown }) => {
    tx.update(t, a.key, a.patch as never);
  });
  const db = track(
    createDb({ features: { f: feature({ tables: { t }, ops: { insert, update } }) }, ...flags }),
  );
  return { t, insert, update, db, lastKey: () => lastKey };
}

/**
 * The spec says schemas whose input and output differ "are rejected", without
 * saying when. Standard Schema has no runtime introspection, so an engine may
 * only find out on the first write that exercises the default/transform. Accept
 * a deliberate error at either point — but not the scaffold's stub error.
 */
function expectRejectedAtDefinitionOrFirstWrite(schema: z.ZodTypeAny, row: unknown): void {
  let error: unknown;
  try {
    const { insert, db } = bench(schema, { key: "id" });
    db.run(insert, row);
  } catch (e) {
    error = e;
  }
  expectDeliberate(error);
}

spec("Tables and schemas", () => {
  const rowSchema = z.object({
    id: z.string(),
    n: z.number(),
    flag: z.boolean(),
    note: z.string().nullable(),
  });

  describe("primary key", () => {
    it("stores and fetches a row by its single-field primary key", () => {
      const { t, insert, db } = bench(rowSchema, { key: "id" });
      db.run(insert, { id: "a", n: 1, flag: true, note: null });
      expect(db.read(t.get("a"))).toEqual({ id: "a", n: 1, flag: true, note: null });
    });

    it("get returns undefined for a missing key", () => {
      const { t, db } = bench(rowSchema, { key: "id" });
      expect(db.read(t.get("nope"))).toBeUndefined();
    });

    it("accepts a number primary key", () => {
      const { t, insert, db } = bench(z.object({ id: z.number(), label: z.string() }), {
        key: "id",
      });
      db.run(insert, { id: 7, label: "seven" });
      expect(db.read(t.get(7 as never))).toEqual({ id: 7, label: "seven" });
      expect(db.read(t.get("7" as never))).toBeUndefined(); // no coercion between types
    });
  });

  describe("key generator", () => {
    it("generates a key when the caller omits it, and insert returns that key", () => {
      let n = 0;
      const { t, insert, db, lastKey } = bench(rowSchema, { key: "id", generate: () => `g${++n}` });
      db.run(insert, { n: 1, flag: false, note: null });
      expect(lastKey()).toBe("g1");
      expect(db.read(t.get("g1"))?.n).toBe(1);
    });

    it("a caller-provided key always wins over the generator", () => {
      const { t, insert, db, lastKey } = bench(rowSchema, {
        key: "id",
        generate: () => "generated",
      });
      db.run(insert, { id: "explicit", n: 1, flag: false, note: null });
      expect(lastKey()).toBe("explicit");
      expect(db.read(t.get("explicit"))).toBeDefined();
      expect(db.read(t.get("generated"))).toBeUndefined();
    });
  });

  describe("schemas only validate", () => {
    it("stores the row exactly as given (no coercion)", () => {
      const { t, insert, db } = bench(rowSchema, { key: "id" });
      const row = { id: "a", n: 1, flag: true, note: "hi" };
      db.run(insert, row);
      expect(db.read(t.get("a"))).toEqual(row);
    });

    it("rejects a schema whose output differs from its input (defaults)", () => {
      // Omitting `n` makes the default kick in, so output ≠ input.
      expectRejectedAtDefinitionOrFirstWrite(
        z.object({ id: z.string(), n: z.number().default(0) }),
        { id: "a" },
      );
    });

    it("rejects a schema whose output differs from its input (transforms)", () => {
      expectRejectedAtDefinitionOrFirstWrite(
        z.object({ id: z.string(), n: z.string().transform(Number) }),
        { id: "a", n: "1" },
      );
    });

    it("throws when an async schema is used on a write", () => {
      const asyncSchema = z.object({
        id: z.string(),
        n: z.number().refine(async () => true),
      });
      const { t, insert, db } = bench(asyncSchema, { key: "id" });
      expectThrows(() => db.run(insert, { id: "a", n: 1 }));
      expect(db.read(t.all())).toEqual([]);
    });
  });

  describe("validation", () => {
    it("throws and rolls back when a write fails validation (on by default)", () => {
      const { t, insert, db } = bench(rowSchema, { key: "id" });
      expectThrows(() => db.run(insert, { id: "a", n: "not a number", flag: true, note: null }));
      expect(db.read(t.all())).toEqual([]);
    });

    it("validates updates too, rolling back the whole op", () => {
      const { t, insert, update, db } = bench(rowSchema, { key: "id" });
      db.run(insert, { id: "a", n: 1, flag: true, note: null });
      expectThrows(() => db.run(update, { key: "a", patch: { n: "nope" } }));
      expect(db.read(t.get("a"))?.n).toBe(1);
    });

    it("skips validation when createDb({ validate: false })", () => {
      const { t, insert, db } = bench(rowSchema, { key: "id" }, { validate: false });
      db.run(insert, { id: "a", n: "nope" });
      expect(db.read(t.get("a"))).toEqual({ id: "a", n: "nope" }); // stored as given
    });
  });

  describe("immutability and freezing", () => {
    it("shallow-freezes stored rows so assigning a field throws (freeze on by default)", () => {
      const { t, insert, db } = bench(rowSchema, { key: "id" });
      db.run(insert, { id: "a", n: 1, flag: true, note: null });
      const row = db.read(t.get("a"));
      expect(Object.isFrozen(row)).toBe(true);
      expect(() => {
        (row as { n: number }).n = 2;
      }).toThrow(TypeError); // strict-mode assignment to a frozen property
    });

    it("does not freeze rows when createDb({ freeze: false })", () => {
      const { t, insert, db } = bench(rowSchema, { key: "id" }, { freeze: false });
      db.run(insert, { id: "a", n: 1, flag: true, note: null });
      expect(Object.isFrozen(db.read(t.get("a")))).toBe(false);
    });

    it("produces a new row object on update (does not mutate the old one)", () => {
      const { t, insert, update, db } = bench(rowSchema, { key: "id" });
      db.run(insert, { id: "a", n: 1, flag: true, note: null });
      const before = db.read(t.get("a"));
      db.run(update, { key: "a", patch: { n: 2 } });
      const after = db.read(t.get("a"));
      expect(after).not.toBe(before);
      expect(before?.n).toBe(1);
      expect(after?.n).toBe(2);
    });

    it("counts every update as a change, even when the new values are identical", async () => {
      const { t, insert, update, db } = bench(rowSchema, { key: "id" });
      db.run(insert, { id: "a", n: 1, flag: true, note: null });
      const seen: unknown[] = [];
      db.subscribe(t.all(), (rows) => seen.push(rows)); // immediate, synchronous call
      await flush(); // let the insert's batch settle first
      seen.length = 0;
      db.run(update, { key: "a", patch: { n: 1 } }); // identical value
      await flush();
      expect(seen).toHaveLength(1);
    });
  });
});
