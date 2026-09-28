import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cachedQueryCount } from "../src/db";
import { aggregate, createDb, feature, op, table } from "../src/index";

// Only watched queries are cached — by a subscriber or a scope's `q.read` — so
// one-shot reads never accumulate cache entries.
describe("query result cache", () => {
  function world() {
    const t = table(z.object({ id: z.string(), n: z.number() }), { key: "id" });
    const agg = aggregate({
      table: table(z.object({ id: z.string(), n: z.number() }), { key: "id" }),
      inputs: [t],
      compute: (q, emit) =>
        q.each(t.all(), (r) => emit({ id: r.id, n: q.read(t.get(r.id))?.n ?? 0 })),
    });
    const put = op((tx, id: string) => {
      tx.insert(t, { id, n: 1 });
      tx.read(t.get(id));
    });
    const del = op((tx, id: string) => {
      tx.delete(t, id);
    });
    const db = createDb({ features: { f: feature({ tables: { t, agg }, ops: { put, del } }) } });
    return { t, agg, put, del, db };
  }

  it("caches nothing for one-shot reads, in or out of ops", () => {
    const { t, put, db } = world();
    for (let i = 0; i < 50; i++) db.run(put, `k${i}`);
    for (let i = 0; i < 50; i++) db.read(t.get(`k${i}`));
    expect(cachedQueryCount(db)).toBe(0);
    expect(db.read(t.all())).not.toBe(db.read(t.all())); // computed fresh each time
    db.dispose();
  });

  it("holds a scope's q.read until the scope is disposed", () => {
    const { agg, put, del, db } = world();
    for (let i = 0; i < 50; i++) db.run(put, `k${i}`);
    expect(db.read(agg.all())).toHaveLength(50);
    expect(cachedQueryCount(db)).toBe(50); // one q.read per row scope

    for (let i = 0; i < 50; i++) db.run(del, `k${i}`);
    expect(db.read(agg.all())).toHaveLength(0);
    expect(cachedQueryCount(db)).toBe(0);
    db.dispose();
  });

  it("holds a subscribed query until its last subscriber leaves", () => {
    const { t, db } = world();
    const stopA = db.subscribe(t.all(), () => {});
    const stopB = db.subscribe(t.all(), () => {});
    expect(cachedQueryCount(db)).toBe(1); // equal queries share one entry
    expect(db.read(t.all())).toBe(db.read(t.all())); // watched: stable identity
    stopA();
    expect(cachedQueryCount(db)).toBe(1);
    stopB();
    expect(cachedQueryCount(db)).toBe(0);
    db.dispose();
  });
});
