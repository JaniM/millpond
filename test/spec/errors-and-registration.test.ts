import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { aggregate, createDb, effect, feature, op, table } from "../../src/index";
import {
  type ChatWorld,
  captureUncaught,
  chatWorld,
  expectThrows,
  flush,
  spec,
  track,
} from "./harness";

// Spec §"Definitions and features → Registration checks" and §"Errors".

spec("Registration checks", () => {
  let w: ChatWorld;
  beforeEach(() => {
    w = chatWorld();
  });

  it("createDb throws when an aggregate input isn't registered", () => {
    const agg = aggregate({
      table: table(z.object({ id: z.string(), n: z.number() }), { key: "id" }),
      inputs: [w.tables.messages], // messages is NOT registered below
      compute: (q, emit) => q.each(w.tables.messages.all(), (m) => emit({ id: m.id, n: 0 })),
    });
    const c = feature({ tables: { threads: w.tables.threads, agg } });
    expectThrows(() => createDb({ features: { c } }));
  });

  it("createDb throws when an effect input isn't registered", () => {
    const watcher = effect({
      inputs: [w.tables.loadRequests], // NOT registered below
      watch: (q, task) => q.each(w.tables.loadRequests.all(), () => task(async () => {})),
    });
    const c = feature({ tables: { threads: w.tables.threads }, effects: { watcher } });
    expectThrows(() => createDb({ features: { c } }));
  });

  it("createDb throws when the same table is registered under two names", () => {
    const a = feature({ tables: { m: w.tables.messages } });
    const b = feature({ tables: { alias: w.tables.messages } }); // same table value, two names
    expectThrows(() => createDb({ features: { a, b } }));
  });

  it("createDb throws when the same op is registered under two names", () => {
    const c = feature({
      tables: { threads: w.tables.threads },
      ops: { createThread: w.ops.createThread, alsoCreateThread: w.ops.createThread },
    });
    expectThrows(() => createDb({ features: { c } }));
  });

  it("namespaces ops by feature and dispatches by identity", () => {
    const a = table(z.object({ id: z.string() }), { key: "id" });
    const b = table(z.object({ id: z.string() }), { key: "id" });
    const aSend = op((tx, x: { id: string }) => {
      tx.insert(a, x);
    });
    const bSend = op((tx, x: { id: string }) => {
      tx.insert(b, x);
    });
    const db = track(
      createDb({
        features: {
          users: feature({ tables: { a }, ops: { send: aSend } }),
          chat: feature({ tables: { b }, ops: { send: bSend } }),
        },
      }),
    );

    // Convenience tree — users.send and chat.send coexist.
    db.ops.users.send({ id: "u1" });
    db.ops.chat.send({ id: "c1" });
    expect(db.read(a.get("u1"))).toBeDefined();
    expect(db.read(b.get("c1"))).toBeDefined();
    expect(db.read(a.get("c1"))).toBeUndefined();

    // Dispatch by value.
    db.run(aSend, { id: "u2" });
    expect(db.read(a.get("u2"))).toBeDefined();
  });

  it("lets the same features back several independent dbs", () => {
    const one = w.create();
    const two = w.create();
    one.run(w.ops.createThread, { id: "t1", title: "one" });
    expect(one.read(w.tables.threads.get("t1"))).toBeDefined();
    expect(two.read(w.tables.threads.get("t1"))).toBeUndefined();
  });
});

spec("Errors", () => {
  let w: ChatWorld;
  beforeEach(() => {
    w = chatWorld();
  });

  // A subscriber that throws on every non-empty result.
  const throwOnRows = (message: string) => (rows: readonly unknown[]) => {
    if (rows.length > 0) throw new Error(message);
  };

  it("reports a throwing subscriber to onError and still calls the others", async () => {
    const errors: unknown[] = [];
    const other = vi.fn();
    const db = w.create({ onError: (e) => errors.push(e) });
    db.subscribe(w.tables.threads.all(), throwOnRows("subscriber boom"));
    db.subscribe(w.tables.threads.all(), other);
    other.mockClear();
    db.run(w.ops.createThread, { id: "t1", title: "one" });
    await flush();
    expect(errors.some((e) => e instanceof Error && e.message === "subscriber boom")).toBe(true);
    expect(other).toHaveBeenCalled();
  });

  it("runs onError after the flush, where it may call an op to record the error", async () => {
    let n = 0;
    const logs = table(z.object({ id: z.string(), message: z.string() }), {
      key: "id",
      generate: () => `l${++n}`,
    });
    const record = op((tx, m: { message: string }) => {
      tx.insert(logs, { message: m.message });
    });
    const createThread = w.ops.createThread;
    const db = track(
      createDb({
        features: {
          c: feature({
            tables: { threads: w.tables.threads, logs },
            ops: { createThread, record },
          }),
        },
        onError: (e, ctx) => ctx.db.ops.c.record({ message: String(e) }),
      }),
    );
    db.subscribe(w.tables.threads.all(), throwOnRows("subscriber boom"));
    db.run(createThread, { id: "t1", title: "one" });
    await flush(); // subscriber throws → onError records
    await flush(); // record op's own batch flushes
    expect(db.read(logs.all()).map((l) => l.message)).toEqual(["Error: subscriber boom"]);
  });

  it("gives onError the registered name of what failed via `source`", async () => {
    let source: string | undefined;
    const collide = aggregate({
      table: table(z.object({ k: z.string() }), { key: "k" }),
      inputs: [w.tables.threads],
      compute: (q, emit) => q.each(w.tables.threads.all(), () => emit({ k: "same" })),
    });
    const db = track(
      createDb({
        features: {
          chat: feature({
            tables: { threads: w.tables.threads, collide },
            ops: { createThread: w.ops.createThread },
          }),
        },
        onError: (_e, ctx) => {
          source = ctx.source;
        },
      }),
    );
    db.run(w.ops.createThread, { id: "t1", title: "one" });
    db.run(w.ops.createThread, { id: "t2", title: "two" });
    await flush();
    // The registered name, plus possibly the key path of the failing scope.
    expect(source).toMatch(/^chat\.collide\b/);
  });

  it("rethrows each reported error from a fresh microtask when there is no onError", async () => {
    const db = w.create(); // no onError
    db.subscribe(w.tables.threads.all(), throwOnRows("subscriber boom"));
    let returned = false;
    const uncaught = await captureUncaught(async () => {
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      returned = true; // the op itself did not throw
      await flush();
    });
    expect(returned).toBe(true);
    expect(uncaught).toHaveLength(1);
    expect((uncaught[0] as Error).message).toBe("subscriber boom");
    expect(db.read(w.tables.threads.get("t1"))).toBeDefined(); // the db stays consistent
  });

  it("rethrows an error thrown by onError, with the original error as its cause", async () => {
    const onError = vi.fn(() => {
      throw new Error("onError boom");
    });
    const db = w.create({ onError });
    db.subscribe(w.tables.threads.all(), throwOnRows("subscriber boom"));
    const uncaught = await captureUncaught(async () => {
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      await flush();
    });
    expect(uncaught).toHaveLength(1);
    const err = uncaught[0] as Error;
    expect(err.message).toBe("onError boom");
    expect((err.cause as Error).message).toBe("subscriber boom");
    // Errors never go back into onError: it was called for the subscriber only.
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
