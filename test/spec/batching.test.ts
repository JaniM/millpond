import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { aggregate, count, createDb, feature, op, table } from "../../src/index";
import { type ChatWorld, chatWorld, flush, spec, track } from "./harness";

// Spec §"Batching and consistency".

spec("Batching and consistency", () => {
  let w: ChatWorld;
  beforeEach(() => {
    w = chatWorld();
  });

  it("commits an op's writes immediately (a read right after sees them, no await)", () => {
    const db = w.create();
    db.run(w.ops.createThread, { id: "t1", title: "one" });
    expect(db.read(w.tables.threads.get("t1"))).toBeDefined();
  });

  it("schedules reactions on a microtask — nothing fires before the await", async () => {
    const db = w.create();
    let fired = false;
    db.subscribe(w.tables.threads.all(), () => {
      fired = true;
    });
    fired = false; // clear the immediate call
    db.run(w.ops.createThread, { id: "t1", title: "one" });
    expect(fired).toBe(false); // flush is still pending
    await flush();
    expect(fired).toBe(true);
  });

  it("collapses a burst of ops into a single subscriber call per batch", async () => {
    const db = w.create();
    db.run(w.ops.createThread, { id: "t1", title: "one" });
    await flush();
    let calls = 0;
    db.subscribe(w.tables.messages.byThread.threadIdEq("t1"), () => {
      calls++;
    });
    calls = 0;
    db.run(w.ops.send, { id: "m1", threadId: "t1", body: "a", sentAt: 1 });
    db.run(w.ops.send, { id: "m2", threadId: "t1", body: "b", sentAt: 2 });
    db.run(w.ops.send, { id: "m3", threadId: "t1", body: "c", sentAt: 3 });
    await flush();
    expect(calls).toBe(1);
  });

  it("recomputes an affected aggregate scope once per batch, not once per op", async () => {
    const threadRuns = vi.fn();
    const perThread = aggregate({
      table: table(z.object({ threadId: z.string(), n: z.number() }), { key: "threadId" }),
      inputs: [w.tables.threads, w.tables.messages],
      compute: (q, emit) =>
        q.each(w.tables.threads.all(), (t) => {
          threadRuns(t.id);
          emit({ threadId: t.id, n: q.reduce(w.tables.messages.byThread.threadIdEq(t.id), count) });
        }),
    });
    const db = track(
      createDb({
        features: {
          c: feature({
            tables: { threads: w.tables.threads, messages: w.tables.messages, perThread },
            ops: { createThread: w.ops.createThread, postMessage: w.ops.postMessage },
          }),
        },
      }),
    );
    db.run(w.ops.createThread, { id: "t1", title: "one" });
    db.subscribe(perThread.all(), () => {}); // keep the aggregate observed
    await flush();
    threadRuns.mockClear();

    db.run(w.ops.postMessage, { id: "m1", threadId: "t1", body: "a", sentAt: 1 });
    db.run(w.ops.postMessage, { id: "m2", threadId: "t1", body: "b", sentAt: 2 });
    db.run(w.ops.postMessage, { id: "m3", threadId: "t1", body: "c", sentAt: 3 });
    await flush();
    expect(threadRuns).toHaveBeenCalledTimes(1);
    expect(db.read(perThread.get("t1"))?.n).toBe(3);
  });

  it("coalesces changes that cancel out within a batch (insert then delete)", async () => {
    const put = op((tx, id: string) => {
      tx.insert(w.tables.messages, { id, threadId: "t1", body: "x", sentAt: 0, editedAt: null });
    });
    const del = op((tx, id: string) => {
      tx.delete(w.tables.messages, id);
    });
    const db = w.create({ ops: { put, del } });
    let calls = 0;
    db.subscribe(w.tables.messages.all(), () => {
      calls++;
    });
    calls = 0;
    db.run(put, "m1");
    db.run(del, "m1"); // same batch — nets to nothing
    await flush();
    expect(calls).toBe(0);
    expect(db.read(w.tables.messages.all())).toHaveLength(0);
  });

  it("brings an aggregate up to date when it is read between commit and flush", () => {
    const db = w.create();
    db.run(w.ops.createThread, { id: "t1", title: "one" });
    db.run(w.ops.send, { id: "m1", threadId: "t1", body: "a", sentAt: 1 });
    db.run(w.ops.addReaction, { id: "r1", messageId: "m1", emoji: "👍" });
    // No await: the read must catch the aggregate up itself.
    expect(db.read(w.tables.threadStats.get("t1"))?.reactions).toBe(1);
  });

  it("runs a pending batch with a single await (there is no flush())", async () => {
    const db = w.create();
    const seen: number[] = [];
    db.subscribe(w.tables.threads.all(), (rows) => {
      seen.push(rows.length);
    });
    db.run(w.ops.createThread, { id: "t1", title: "one" });
    await flush();
    expect(seen).toEqual([0, 1]); // immediate empty result, then after the batch
  });
});
