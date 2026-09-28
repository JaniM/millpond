import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { op, table } from "../../src/index";
import { type ChatWorld, chatWorld, expectThrows, flush, spec } from "./harness";

// Spec §"Ops". Every op run here is registered via `w.create({ ops })`, since
// db.run with an unregistered op throws.

spec("Ops", () => {
  let w: ChatWorld;

  beforeEach(() => {
    w = chatWorld();
  });

  const message = (id: string) => ({ id, threadId: "t1", body: "hi", sentAt: 1, editedAt: null });

  describe("tx.insert", () => {
    it("inserts the row and returns its key inside the op", () => {
      let key: unknown;
      const capture = op((tx, m: { id: string }) => {
        key = tx.insert(w.tables.messages, message(m.id));
      });
      const db = w.create({ ops: { capture } });
      db.run(capture, { id: "m1" });
      expect(key).toBe("m1");
    });

    it("throws when the key already exists, keeping the original row", () => {
      const db = w.create();
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.run(w.ops.send, { id: "m1", threadId: "t1", body: "a", sentAt: 1 });
      expectThrows(() => db.run(w.ops.send, { id: "m1", threadId: "t1", body: "dup", sentAt: 2 }));
      expect(db.read(w.tables.messages.get("m1"))?.body).toBe("a");
    });
  });

  describe("tx.update", () => {
    it("shallow-merges the patch into a new row, keeping untouched fields", () => {
      const db = w.create();
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.run(w.ops.send, { id: "m1", threadId: "t1", body: "a", sentAt: 1 });
      db.run(w.ops.editBody, { id: "m1", body: "edited" });
      const row = db.read(w.tables.messages.get("m1"));
      expect(row?.body).toBe("edited");
      expect(row?.sentAt).toBe(1); // untouched field preserved
    });

    it("supports a patch computed from the current row", () => {
      const bang = op((tx, id: string) => {
        tx.update(w.tables.messages, id, (row) => ({ body: `${row.body}!` }));
      });
      const db = w.create({ ops: { bang } });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.run(w.ops.send, { id: "m1", threadId: "t1", body: "a", sentAt: 1 });
      db.run(bang, "m1");
      expect(db.read(w.tables.messages.get("m1"))?.body).toBe("a!");
    });

    it("throws when the key is missing", () => {
      const db = w.create();
      expectThrows(() => db.run(w.ops.editBody, { id: "missing", body: "x" }));
    });

    it("throws when the patch would change the key", () => {
      const rekey = op((tx) => {
        tx.update(w.tables.messages, "m1", { id: "m2" });
      });
      const db = w.create({ ops: { rekey } });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.run(w.ops.send, { id: "m1", threadId: "t1", body: "a", sentAt: 1 });
      expectThrows(() => db.run(rekey, undefined));
      expect(db.read(w.tables.messages.get("m1"))).toBeDefined();
      expect(db.read(w.tables.messages.get("m2"))).toBeUndefined();
    });
  });

  describe("tx.upsert", () => {
    it("inserts when absent and replaces when present, returning the key", () => {
      const keys: unknown[] = [];
      const put = op((tx, m: { id: string; body: string }) => {
        keys.push(tx.upsert(w.tables.messages, { ...message(m.id), body: m.body }));
      });
      const db = w.create({ ops: { put } });
      db.run(put, { id: "m1", body: "first" });
      db.run(put, { id: "m1", body: "second" });
      expect(db.read(w.tables.messages.get("m1"))?.body).toBe("second");
      expect(keys).toEqual(["m1", "m1"]);
    });
  });

  describe("tx.delete", () => {
    it("deletes the row", () => {
      const del = op((tx, id: string) => {
        tx.delete(w.tables.messages, id);
      });
      const db = w.create({ ops: { del } });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.run(w.ops.send, { id: "m1", threadId: "t1", body: "a", sentAt: 1 });
      db.run(del, "m1");
      expect(db.read(w.tables.messages.get("m1"))).toBeUndefined();
    });

    it("throws when the key is missing", () => {
      const del = op((tx) => {
        tx.delete(w.tables.messages, "missing");
      });
      const db = w.create({ ops: { del } });
      expectThrows(() => db.run(del, undefined));
    });
  });

  describe("tx.read", () => {
    it("includes the op's own writes", () => {
      let seenInside = 0;
      const insertThenCount = op((tx) => {
        tx.insert(w.tables.messages, message("m1"));
        seenInside = tx.read(w.tables.messages.byThread.threadIdEq("t1")).length;
      });
      const db = w.create({ ops: { insertThenCount } });
      db.run(insertThenCount, undefined);
      expect(seenInside).toBe(1);
    });
  });

  describe("atomicity", () => {
    it("commits all of an op's writes or none, and rethrows the error", () => {
      const boom = op((tx) => {
        tx.update(w.tables.threads, "t1", { title: "changed" });
        throw new Error("boom");
      });
      const db = w.create({ ops: { boom } });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      expect(() => db.run(boom, undefined)).toThrow("boom");
      expect(db.read(w.tables.threads.get("t1"))?.title).toBe("one"); // rolled back
    });

    it("never notifies subscribers of a rolled-back op", async () => {
      const boom = op((tx) => {
        tx.update(w.tables.threads, "t1", { title: "changed" });
        throw new Error("boom");
      });
      const db = w.create({ ops: { boom } });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      await flush();
      let calls = 0;
      db.subscribe(w.tables.threads.all(), () => {
        calls++;
      });
      expect(() => db.run(boom, undefined)).toThrow("boom");
      await flush();
      expect(calls).toBe(1); // only the immediate call
    });
  });

  describe("nested ops as savepoints", () => {
    it("undoes only the nested op's writes when it throws and the caller catches", () => {
      const inner = op((tx) => {
        tx.update(w.tables.threads, "t1", { title: "inner" });
        throw new Error("inner boom");
      });
      const outer = op((tx) => {
        tx.update(w.tables.threads, "t1", { archived: true });
        try {
          tx.run(inner, undefined);
        } catch {
          // swallow — outer writes should still commit
        }
      });
      const db = w.create({ ops: { inner, outer } });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.run(outer, undefined);
      const row = db.read(w.tables.threads.get("t1"));
      expect(row?.title).toBe("one"); // nested write rolled back to the savepoint
      expect(row?.archived).toBe(true); // outer write kept
    });

    it("rolls back the whole op when a nested op's error is not caught", () => {
      const inner = op((tx) => {
        tx.update(w.tables.threads, "t1", { title: "inner" });
        throw new Error("inner boom");
      });
      const outer = op((tx) => {
        tx.update(w.tables.threads, "t1", { archived: true });
        tx.run(inner, undefined);
      });
      const db = w.create({ ops: { inner, outer } });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      expect(() => db.run(outer, undefined)).toThrow("inner boom");
      const row = db.read(w.tables.threads.get("t1"));
      expect(row?.title).toBe("one");
      expect(row?.archived).toBe(false);
    });

    it("commits a nested op's writes with the caller's", () => {
      const outer = op((tx) => {
        tx.run(w.ops.createThread, { id: "t1", title: "one" });
        tx.run(w.ops.send, { id: "m1", threadId: "t1", body: "a", sentAt: 1 });
      });
      const db = w.create({ ops: { outer } });
      db.run(outer, undefined);
      expect(db.read(w.tables.threads.get("t1"))?.lastMessageId).toBe("m1");
    });
  });

  describe("return values", () => {
    it("db.run returns nothing (ops return nothing)", () => {
      const db = w.create();
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      expect(
        db.run(w.ops.send, { id: "m1", threadId: "t1", body: "a", sentAt: 1 }),
      ).toBeUndefined();
    });

    it("throws when an op returns a promise, rolling back its writes", () => {
      const asyncOp = op(async (tx) => {
        tx.update(w.tables.threads, "t1", { title: "async" });
      });
      const db = w.create({ ops: { asyncOp } });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      expectThrows(() => db.run(asyncOp, undefined));
      expect(db.read(w.tables.threads.get("t1"))?.title).toBe("one");
    });
  });

  describe("aggregates inside an op", () => {
    it("reflect the op's start, not its own writes", () => {
      let statInside: number | undefined;
      const react = op((tx) => {
        tx.insert(w.tables.reactions, { id: "r1", messageId: "m1", emoji: "👍" });
        statInside = tx.read(w.tables.threadStats.get("t1"))?.reactions;
      });
      const db = w.create({ ops: { react } });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.run(w.ops.send, { id: "m1", threadId: "t1", body: "a", sentAt: 1 });
      db.run(react, undefined);
      expect(statInside).toBe(0); // the op's own reaction is not reflected
      expect(db.read(w.tables.threadStats.get("t1"))?.reactions).toBe(1); // but is after commit
    });
  });

  describe("guards", () => {
    it("throws when db.run is given an unregistered op", () => {
      const stray = op((tx) => {
        tx.update(w.tables.threads, "t1", { title: "x" });
      });
      const db = w.create(); // `stray` is deliberately not registered
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      expectThrows(() => db.run(stray, undefined));
      expect(db.read(w.tables.threads.get("t1"))?.title).toBe("one");
    });

    it("throws when tx.run is given an unregistered op", () => {
      const stray = op((tx) => {
        tx.update(w.tables.threads, "t1", { title: "x" });
      });
      const outer = op((tx) => {
        tx.run(stray, undefined);
      });
      const db = w.create({ ops: { outer } }); // `stray` is not registered
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      expectThrows(() => db.run(outer, undefined));
      expect(db.read(w.tables.threads.get("t1"))?.title).toBe("one");
    });

    it("throws when an op writes to a table that isn't registered", () => {
      const orphan = table(z.object({ id: z.string() }), { key: "id" });
      const writeOrphan = op((tx) => {
        tx.insert(orphan, { id: "x" });
      });
      const db = w.create({ ops: { writeOrphan } }); // `orphan` table not registered
      expectThrows(() => db.run(writeOrphan, undefined));
    });

    it("throws when an op reads a table that isn't registered", () => {
      const orphan = table(z.object({ id: z.string() }), { key: "id" });
      const readOrphan = op((tx) => {
        tx.read(orphan.all());
      });
      const db = w.create({ ops: { readOrphan } });
      expectThrows(() => db.run(readOrphan, undefined));
    });

    it("throws when an op writes to an aggregate table", () => {
      const writeAgg = op((tx) => {
        tx.insert(w.tables.threadStats, { threadId: "t1", reactions: 0 });
      });
      const db = w.create({ ops: { writeAgg } });
      expectThrows(() => db.run(writeAgg, undefined));
    });
  });
});
