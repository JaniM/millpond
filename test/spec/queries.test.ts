import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type AnyDb, createDb, feature, op, table } from "../../src/index";
import { type ChatWorld, chatWorld, expectReported, flush, spec, track } from "./harness";

// Spec §"Queries and subscriptions".

spec("Queries and subscriptions", () => {
  let w: ChatWorld;
  let db: AnyDb;
  let errors: unknown[];

  // Two threads with messages at known timestamps.
  beforeEach(() => {
    w = chatWorld();
    errors = [];
    db = w.create({ onError: (e) => errors.push(e) });
    db.run(w.ops.createThread, { id: "t1", title: "one" });
    db.run(w.ops.createThread, { id: "t2", title: "two" });
    db.run(w.ops.send, { id: "m1", threadId: "t1", body: "a", sentAt: 10 });
    db.run(w.ops.send, { id: "m2", threadId: "t1", body: "b", sentAt: 20 });
    db.run(w.ops.send, { id: "m3", threadId: "t1", body: "c", sentAt: 30 });
    db.run(w.ops.send, { id: "n1", threadId: "t2", body: "x", sentAt: 15 });
  });

  const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id).sort();

  describe("reading", () => {
    it("all() returns every row of the table", () => {
      expect(ids(db.read(w.tables.messages.all()))).toEqual(["m1", "m2", "m3", "n1"]);
    });

    it("an index prefix returns every row under it", () => {
      expect(ids(db.read(w.tables.messages.byThread.threadIdEq("t1")))).toEqual(["m1", "m2", "m3"]);
    });

    it("equality on every index column narrows to the exact match", () => {
      const q = w.tables.messages.byThread.threadIdEq("t1").sentAtEq(20);
      expect(ids(db.read(q))).toEqual(["m2"]);
    });

    it("a prefix then a range bounds the next column", () => {
      const rows = db.read(w.tables.messages.byThread.threadIdEq("t1").sentAtGte(20).sentAtLt(30));
      expect(ids(rows)).toEqual(["m2"]);
    });

    it("an upper bound first, then a lower bound, forms the same range", () => {
      const rows = db.read(w.tables.messages.byThread.threadIdEq("t1").sentAtLt(30).sentAtGte(20));
      expect(ids(rows)).toEqual(["m2"]);
    });

    it("supports Gt / Gte / Lt / Lte comparisons", () => {
      const q = w.tables.messages.byThread.threadIdEq("t1");
      expect(ids(db.read(q.sentAtGt(20)))).toEqual(["m3"]);
      expect(ids(db.read(q.sentAtGte(20)))).toEqual(["m2", "m3"]);
      expect(ids(db.read(q.sentAtLt(20)))).toEqual(["m1"]);
      expect(ids(db.read(q.sentAtLte(20)))).toEqual(["m1", "m2"]);
    });

    it("returns a readonly array (enforced by the types)", () => {
      const rows = db.read(w.tables.messages.all());
      expect(Array.isArray(rows)).toBe(true);
      // Never called: the check is that this fails to typecheck.
      const mutate = () => {
        // @ts-expect-error — results are readonly arrays
        rows.push(rows[0]);
      };
      void mutate;
    });
  });

  describe("index columns", () => {
    // A table whose index mixes nullable, boolean and number columns.
    function tasks() {
      const t = table(
        z.object({
          id: z.string(),
          owner: z.string().nullable(),
          done: z.boolean(),
          priority: z.number(),
        }),
        { key: "id", indexes: { byOwner: ["owner", "priority"], byDone: ["done", "priority"] } },
      );
      const put = op(
        (tx, row: { id: string; owner: string | null; done: boolean; priority: number }) => {
          tx.insert(t, row);
        },
      );
      const tdb = track(createDb({ features: { f: feature({ tables: { t }, ops: { put } }) } }));
      tdb.run(put, { id: "a", owner: null, done: false, priority: 1 });
      tdb.run(put, { id: "b", owner: "ann", done: true, priority: 2 });
      tdb.run(put, { id: "c", owner: null, done: true, priority: 3 });
      return { t, tdb };
    }

    it("matches null with equality on a nullable column", () => {
      const { t, tdb } = tasks();
      expect(ids(tdb.read(t.byOwner.ownerEq(null)))).toEqual(["a", "c"]);
      expect(ids(tdb.read(t.byOwner.ownerEq("ann")))).toEqual(["b"]);
    });

    it("indexes boolean and number columns", () => {
      const { t, tdb } = tasks();
      expect(ids(tdb.read(t.byDone.doneEq(true)))).toEqual(["b", "c"]);
      expect(ids(tdb.read(t.byDone.doneEq(true).priorityGt(2)))).toEqual(["c"]);
    });
  });

  describe("structural identity", () => {
    it("equal queries share one subscription result — the same array object", () => {
      const seen: unknown[] = [];
      db.subscribe(w.tables.messages.byThread.threadIdEq("t1"), (rows) => seen.push(rows));
      db.subscribe(w.tables.messages.byThread.threadIdEq("t1"), (rows) => seen.push(rows));
      expect(seen).toHaveLength(2);
      expect(seen[1]).toBe(seen[0]); // same array object, not just equal
      // A one-shot read of an equal, subscribed query hits the same cache.
      expect(db.read(w.tables.messages.byThread.threadIdEq("t1"))).toBe(seen[0]);
    });

    it("keeps the same array object when the result has not changed", async () => {
      let latest: unknown;
      db.subscribe(w.tables.messages.byThread.threadIdEq("t1"), (rows) => {
        latest = rows;
      });
      const before = latest;
      db.run(w.ops.postMessage, { id: "n2", threadId: "t2", body: "y", sentAt: 99 }); // other thread
      await flush();
      expect(latest).toBe(before);
      expect(db.read(w.tables.messages.byThread.threadIdEq("t1"))).toBe(before);
    });
  });

  describe("subscribe", () => {
    it("calls back immediately with the current result", () => {
      const seen: (readonly { id: string }[])[] = [];
      db.subscribe(w.tables.messages.byThread.threadIdEq("t1"), (rows) => {
        seen.push(rows);
      });
      expect(seen).toHaveLength(1);
      expect(ids(seen[0] ?? [])).toEqual(["m1", "m2", "m3"]);
    });

    it("fires once per flush in which a row in the result changed", async () => {
      await flush(); // settle the setup batch
      let calls = 0;
      db.subscribe(w.tables.messages.byThread.threadIdEq("t1"), () => {
        calls++;
      });
      expect(calls).toBe(1); // immediate
      db.run(w.ops.send, { id: "m4", threadId: "t1", body: "d", sentAt: 40 });
      await flush();
      expect(calls).toBe(2);
    });

    it("fires when a row in the result is updated or removed, not only added", async () => {
      await flush();
      let calls = 0;
      db.subscribe(w.tables.messages.byThread.threadIdEq("t1"), () => {
        calls++;
      });
      db.run(w.ops.editBody, { id: "m1", body: "edited" });
      await flush();
      expect(calls).toBe(2);
      db.run(w.ops.archive, { threadId: "t1" });
      await flush();
      expect(calls).toBe(3);
    });

    it("subscribes to a get() query", async () => {
      await flush();
      const seen: unknown[] = [];
      db.subscribe(w.tables.messages.get("m1"), (row) => seen.push(row));
      db.run(w.ops.editBody, { id: "m1", body: "edited" });
      await flush();
      expect(seen).toHaveLength(2);
      expect((seen[1] as { body: string }).body).toBe("edited");
    });

    it("does not fire when only unrelated rows change", async () => {
      await flush();
      let calls = 0;
      db.subscribe(w.tables.messages.byThread.threadIdEq("t1"), () => {
        calls++;
      });
      calls = 0;
      db.run(w.ops.postMessage, { id: "n2", threadId: "t2", body: "y", sentAt: 99 });
      await flush();
      expect(calls).toBe(0);
    });

    it("returns an unsubscribe function that stops further calls", async () => {
      await flush();
      let calls = 0;
      const stop = db.subscribe(w.tables.messages.byThread.threadIdEq("t1"), () => {
        calls++;
      });
      stop();
      db.run(w.ops.send, { id: "m4", threadId: "t1", body: "d", sentAt: 40 });
      await flush();
      expect(calls).toBe(1); // only the immediate call
    });

    it("throws if a subscriber callback calls an op, reporting it and dropping the write", async () => {
      await flush();
      let call = 0;
      db.subscribe(w.tables.messages.all(), () => {
        // Skip the immediate, synchronous call so the op runs inside a flush.
        if (++call === 2)
          db.run(w.ops.postMessage, { id: "z", threadId: "t1", body: "z", sentAt: 1 });
      });
      db.run(w.ops.postMessage, { id: "m4", threadId: "t1", body: "d", sentAt: 40 });
      await flush();
      expect(call).toBe(2);
      expectReported(errors); // the op threw inside the subscriber → onError
      expect(db.read(w.tables.messages.get("z"))).toBeUndefined();
    });
  });

  describe("reads outside ops", () => {
    it("see all committed data", () => {
      expect(db.read(w.tables.threads.all())).toHaveLength(2);
      expect(db.read(w.tables.messages.all())).toHaveLength(4);
    });
  });
});
