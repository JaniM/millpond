import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AnyDb, Reducer } from "../../src/index";
import { aggregate, count, createDb, feature, max, sum, table } from "../../src/index";
import { type ChatWorld, chatWorld, expectReported, flush, spec, track } from "./harness";

// Spec §"Aggregates".

spec("Aggregates", () => {
  let w: ChatWorld;
  beforeEach(() => {
    w = chatWorld();
  });

  // Build a db from a single feature with the given tables. Every harness op
  // is registered; ops touching tables that aren't registered simply go unused.
  const build = (
    tables: Record<string, unknown>,
    opts: { onError?: (e: unknown, i: { db: AnyDb; source: string }) => void } = {},
  ): AnyDb =>
    track(createDb({ features: { c: feature({ tables: tables as never, ops: w.ops }) }, ...opts }));

  // Messages per thread, recording which thread scopes run.
  const perThreadCount = (seen: (id: string) => void) =>
    aggregate({
      table: table(z.object({ threadId: z.string(), n: z.number() }), { key: "threadId" }),
      inputs: [w.tables.threads, w.tables.messages],
      compute: (q, emit) =>
        q.each(w.tables.threads.all(), (t) => {
          seen(t.id);
          emit({ threadId: t.id, n: q.reduce(w.tables.messages.byThread.threadIdEq(t.id), count) });
        }),
    });

  describe("as a derived table", () => {
    it("maintains one derived row per input row", () => {
      const db = w.create();
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.run(w.ops.createThread, { id: "t2", title: "two" });
      expect(db.read(w.tables.threadStats.all())).toHaveLength(2);
      expect(db.read(w.tables.threadStats.get("t1"))).toEqual({ threadId: "t1", reactions: 0 });
    });

    it("recomputes incrementally when a deeply-nested input changes", () => {
      const db = w.create();
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.run(w.ops.send, { id: "m1", threadId: "t1", body: "a", sentAt: 1 });
      expect(db.read(w.tables.threadStats.get("t1"))?.reactions).toBe(0);
      db.run(w.ops.addReaction, { id: "r1", messageId: "m1", emoji: "👍" });
      expect(db.read(w.tables.threadStats.get("t1"))?.reactions).toBe(1);
      db.run(w.ops.removeReaction, "r1");
      expect(db.read(w.tables.threadStats.get("t1"))?.reactions).toBe(0);
    });

    it("can take another aggregate as an input", () => {
      const perThread = perThreadCount(() => {});
      const total = aggregate({
        table: table(z.object({ id: z.string(), n: z.number() }), { key: "id" }),
        inputs: [perThread],
        compute: (q, emit) => emit({ id: "all", n: q.reduce(perThread.all(), (r) => r.n, sum) }),
      });
      const db = build({
        threads: w.tables.threads,
        messages: w.tables.messages,
        perThread,
        total,
      });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.run(w.ops.createThread, { id: "t2", title: "two" });
      db.run(w.ops.postMessage, { id: "m1", threadId: "t1", body: "a", sentAt: 1 });
      db.run(w.ops.postMessage, { id: "m2", threadId: "t2", body: "b", sentAt: 2 });
      expect(db.read(total.get("all"))?.n).toBe(2);
    });
  });

  describe("scopes", () => {
    it("reruns only the scopes whose reads a change touched", () => {
      const seen = vi.fn();
      const perThread = perThreadCount(seen);
      const db = build({ threads: w.tables.threads, messages: w.tables.messages, perThread });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.run(w.ops.createThread, { id: "t2", title: "two" });
      db.read(perThread.all()); // force initial compute
      seen.mockClear();

      // postMessage leaves the thread row alone, so t1 can only rerun because
      // its messages read was tracked.
      db.run(w.ops.postMessage, { id: "m1", threadId: "t1", body: "a", sentAt: 1 });
      expect(db.read(perThread.get("t1"))?.n).toBe(1);
      expect(seen).toHaveBeenCalledWith("t1");
      expect(seen).not.toHaveBeenCalledWith("t2"); // t2's scope untouched
    });

    it("stops early: a child rerun with an unchanged value does not rerun its parent", () => {
      const threadRuns = vi.fn();
      const messageRuns = vi.fn();
      const latest = aggregate({
        table: table(z.object({ threadId: z.string(), last: z.number().nullable() }), {
          key: "threadId",
        }),
        inputs: [w.tables.threads, w.tables.messages],
        compute: (q, emit) =>
          q.each(w.tables.threads.all(), (t) => {
            threadRuns(t.id);
            const last = q.reduce(
              w.tables.messages.byThread.threadIdEq(t.id),
              (m) => {
                messageRuns(m.id);
                return m.sentAt;
              },
              max,
            );
            emit({ threadId: t.id, last: last ?? null });
          }),
      });
      const db = build({ threads: w.tables.threads, messages: w.tables.messages, latest });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.run(w.ops.postMessage, { id: "m1", threadId: "t1", body: "a", sentAt: 10 });
      db.read(latest.all());
      threadRuns.mockClear();
      messageRuns.mockClear();

      db.run(w.ops.editBody, { id: "m1", body: "edited" }); // sentAt unchanged
      db.read(latest.all());
      expect(messageRuns).toHaveBeenCalledWith("m1"); // the child reran…
      expect(threadRuns).not.toHaveBeenCalled(); // …but returned the same value
    });

    it("reruns children when their parent's row changes, since they may capture it", () => {
      const labels = aggregate({
        table: table(z.object({ id: z.string(), label: z.string() }), { key: "id" }),
        inputs: [w.tables.threads, w.tables.messages],
        compute: (q, emit) =>
          q.each(w.tables.threads.all(), (t) =>
            q.each(w.tables.messages.byThread.threadIdEq(t.id), (m) =>
              emit({ id: m.id, label: `${t.title}: ${m.body}` }),
            ),
          ),
      });
      const db = build({ threads: w.tables.threads, messages: w.tables.messages, labels });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.run(w.ops.postMessage, { id: "m1", threadId: "t1", body: "hi", sentAt: 1 });
      expect(db.read(labels.get("m1"))?.label).toBe("one: hi");

      db.run(w.ops.renameThread, { id: "t1", title: "uno" }); // only the parent's input
      expect(db.read(labels.get("m1"))?.label).toBe("uno: hi");
    });

    it("rerunOn narrows a scope's reruns to the listed fields", () => {
      const seen = vi.fn();
      const titles = aggregate({
        table: table(z.object({ threadId: z.string(), title: z.string() }), { key: "threadId" }),
        inputs: [w.tables.threads],
        compute: (q, emit) =>
          q.each(
            w.tables.threads.all(),
            (t) => {
              seen(t.id);
              emit({ threadId: t.id, title: t.title });
            },
            { rerunOn: ["title"] },
          ),
      });
      const db = build({ threads: w.tables.threads, messages: w.tables.messages, titles });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.read(titles.all());
      seen.mockClear();

      db.run(w.ops.archive, { threadId: "t1" }); // `archived` is not in rerunOn
      db.read(titles.all());
      expect(seen).not.toHaveBeenCalled();

      db.run(w.ops.renameThread, { id: "t1", title: "renamed" }); // listed field
      expect(db.read(titles.get("t1"))?.title).toBe("renamed");
      expect(seen).toHaveBeenCalledWith("t1");
    });

    it("passes q.each the row as of its scope's previous run, undefined on the first", () => {
      const seen: [string, string | undefined, boolean][] = [];
      const counts = aggregate({
        table: table(z.object({ threadId: z.string(), n: z.number() }), { key: "threadId" }),
        inputs: [w.tables.threads, w.tables.messages],
        compute: (q, emit) =>
          q.each(w.tables.threads.all(), (t, prev) => {
            seen.push([t.title, prev?.title, prev === t]);
            emit({
              threadId: t.id,
              n: q.reduce(w.tables.messages.byThread.threadIdEq(t.id), count),
            });
          }),
      });
      const db = build({ threads: w.tables.threads, messages: w.tables.messages, counts });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.read(counts.all());
      db.run(w.ops.renameThread, { id: "t1", title: "uno" });
      db.read(counts.all());
      db.run(w.ops.postMessage, { id: "m1", threadId: "t1", body: "a", sentAt: 1 }); // row untouched
      db.read(counts.all());
      expect(seen).toEqual([
        ["one", undefined, false],
        ["uno", "one", false],
        ["uno", "uno", true], // reran for its count, so the snapshot is the same row
      ]);
    });

    it("passes q.each the snapshot from the last rerun, even when rerunOn skipped updates", () => {
      const prevs: (boolean | undefined)[] = [];
      const titles = aggregate({
        table: table(z.object({ threadId: z.string(), title: z.string() }), { key: "threadId" }),
        inputs: [w.tables.threads],
        compute: (q, emit) =>
          q.each(
            w.tables.threads.all(),
            (t, prev) => {
              prevs.push(prev?.archived);
              emit({ threadId: t.id, title: t.title });
            },
            { rerunOn: ["title"] },
          ),
      });
      const db = build({ threads: w.tables.threads, messages: w.tables.messages, titles });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.read(titles.all());
      db.run(w.ops.archive, { threadId: "t1" }); // not in rerunOn: no rerun
      db.read(titles.all());
      db.run(w.ops.renameThread, { id: "t1", title: "renamed" });
      db.read(titles.all());
      expect(prevs).toEqual([undefined, false]); // the snapshot predates `archived: true`
    });

    it("passes q.each the row from the last successful run after a failed one", async () => {
      const prevs: (string | undefined)[] = [];
      const titles = aggregate({
        table: table(z.object({ threadId: z.string(), title: z.string() }), { key: "threadId" }),
        inputs: [w.tables.threads],
        compute: (q, emit) =>
          q.each(w.tables.threads.all(), (t, prev) => {
            prevs.push(prev?.title);
            if (t.title === "bad") throw new Error("compute boom");
            emit({ threadId: t.id, title: t.title });
          }),
      });
      const db = build({ threads: w.tables.threads, titles }, { onError: () => {} });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      await flush();
      db.run(w.ops.renameThread, { id: "t1", title: "bad" });
      await flush();
      db.run(w.ops.renameThread, { id: "t1", title: "fixed" });
      await flush();
      expect(prevs).toEqual([undefined, "one", "one"]); // the retry sees what the failed run saw
    });

    it("q.with calls fn once with the whole result, in its own scope", () => {
      const threadRuns = vi.fn();
      const withRuns = vi.fn();
      const sizes = aggregate({
        table: table(z.object({ threadId: z.string(), n: z.number() }), { key: "threadId" }),
        inputs: [w.tables.threads, w.tables.messages],
        compute: (q, emit) =>
          q.each(w.tables.threads.all(), (t) => {
            threadRuns(t.id);
            const n = q.with(w.tables.messages.byThread.threadIdEq(t.id), (ms) => {
              withRuns(ms.map((m) => m.id));
              return ms.length;
            });
            emit({ threadId: t.id, n });
          }),
      });
      const db = build({ threads: w.tables.threads, messages: w.tables.messages, sizes });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.run(w.ops.postMessage, { id: "m1", threadId: "t1", body: "a", sentAt: 1 });
      db.run(w.ops.postMessage, { id: "m2", threadId: "t1", body: "b", sentAt: 2 });
      expect(db.read(sizes.get("t1"))?.n).toBe(2);
      expect(withRuns).toHaveBeenLastCalledWith(["m1", "m2"]);
      threadRuns.mockClear();
      withRuns.mockClear();

      db.run(w.ops.editBody, { id: "m1", body: "edited" }); // a row in the result changed…
      db.read(sizes.all());
      expect(withRuns).toHaveBeenCalledTimes(1); // …so the with scope reran…
      expect(threadRuns).not.toHaveBeenCalled(); // …but returned the same count

      db.run(w.ops.postMessage, { id: "m3", threadId: "t1", body: "c", sentAt: 3 });
      expect(db.read(sizes.get("t1"))?.n).toBe(3);
      expect(withRuns).toHaveBeenLastCalledWith(["m1", "m2", "m3"]);
      expect(threadRuns).toHaveBeenCalledWith("t1");
    });

    it("q.with reruns on rows entering or leaving, and on changes only in rerunOn fields", () => {
      const runs = vi.fn();
      const latest = aggregate({
        table: table(z.object({ id: z.string(), last: z.number() }), { key: "id" }),
        inputs: [w.tables.messages],
        compute: (q, emit) =>
          emit({
            id: "all",
            last: q.with(
              w.tables.messages.all(),
              (ms) => {
                runs();
                return Math.max(0, ...ms.map((m) => m.sentAt));
              },
              { rerunOn: ["sentAt"] },
            ),
          }),
      });
      const db = build({ threads: w.tables.threads, messages: w.tables.messages, latest });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.run(w.ops.postMessage, { id: "m1", threadId: "t1", body: "a", sentAt: 1 });
      expect(db.read(latest.get("all"))?.last).toBe(1);
      runs.mockClear();

      db.run(w.ops.editBody, { id: "m1", body: "edited" }); // not in rerunOn
      db.read(latest.all());
      expect(runs).not.toHaveBeenCalled();

      db.run(w.ops.postMessage, { id: "m2", threadId: "t1", body: "b", sentAt: 5 }); // enters
      expect(db.read(latest.get("all"))?.last).toBe(5);
      db.run(w.ops.archive, { threadId: "t1" }); // both leave
      expect(db.read(latest.get("all"))?.last).toBe(0);
      expect(runs).toHaveBeenCalledTimes(2);
    });
  });

  describe("reducers", () => {
    it("folds a mapped value with max, which is undefined for an empty group", () => {
      let emptyResult: unknown = "unset";
      const latest = aggregate({
        table: table(z.object({ threadId: z.string(), last: z.number().nullable() }), {
          key: "threadId",
        }),
        inputs: [w.tables.threads, w.tables.messages],
        compute: (q, emit) =>
          q.each(w.tables.threads.all(), (t) => {
            const last = q.reduce(
              w.tables.messages.byThread.threadIdEq(t.id),
              (m) => m.sentAt,
              max,
            );
            if (t.id === "empty") emptyResult = last;
            emit({ threadId: t.id, last: last ?? null });
          }),
      });
      const db = build({ threads: w.tables.threads, messages: w.tables.messages, latest });
      db.run(w.ops.createThread, { id: "empty", title: "none" });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.run(w.ops.postMessage, { id: "m1", threadId: "t1", body: "a", sentAt: 10 });
      db.run(w.ops.postMessage, { id: "m2", threadId: "t1", body: "b", sentAt: 30 });
      db.run(w.ops.postMessage, { id: "m3", threadId: "t1", body: "c", sentAt: 20 });
      expect(db.read(latest.get("t1"))?.last).toBe(30);
      expect(emptyResult).toBeUndefined();
    });

    it("supports a custom reducer that mutates its accumulator and provides result", () => {
      // Distinct emoji per message: a multiset in a Map, exposed as its size.
      const distinct: Reducer<string, Map<string, number>, number> = {
        init: () => new Map(),
        add: (acc, v) => acc.set(v, (acc.get(v) ?? 0) + 1),
        remove: (acc, v) => {
          const n = (acc.get(v) ?? 0) - 1;
          if (n > 0) acc.set(v, n);
          else acc.delete(v);
          return acc;
        },
        result: (acc) => acc.size,
      };
      const emojis = aggregate({
        table: table(z.object({ id: z.string(), distinct: z.number() }), { key: "id" }),
        inputs: [w.tables.messages, w.tables.reactions],
        compute: (q, emit) =>
          q.each(w.tables.messages.all(), (m) =>
            emit({
              id: m.id,
              distinct: q.reduce(
                w.tables.reactions.byMessage.messageIdEq(m.id),
                (r) => r.emoji,
                distinct,
              ),
            }),
          ),
      });
      const db = build({ messages: w.tables.messages, reactions: w.tables.reactions, emojis });
      db.run(w.ops.postMessage, { id: "m1", threadId: "t1", body: "a", sentAt: 1 });
      db.run(w.ops.addReaction, { id: "r1", messageId: "m1", emoji: "👍" });
      db.run(w.ops.addReaction, { id: "r2", messageId: "m1", emoji: "👍" });
      db.run(w.ops.addReaction, { id: "r3", messageId: "m1", emoji: "❤️" });
      expect(db.read(emojis.get("m1"))?.distinct).toBe(2);
      db.run(w.ops.removeReaction, "r1"); // one 👍 left
      expect(db.read(emojis.get("m1"))?.distinct).toBe(2);
      db.run(w.ops.removeReaction, "r3");
      expect(db.read(emojis.get("m1"))?.distinct).toBe(1);
    });
  });

  describe("output", () => {
    it("removes a scope's rows when its input row goes away", () => {
      const db = w.create();
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      expect(db.read(w.tables.threadStats.get("t1"))).toBeDefined();
      db.run(w.ops.removeThread, "t1");
      expect(db.read(w.tables.threadStats.get("t1"))).toBeUndefined();
    });

    it("cascades disposal to rows emitted by nested scopes", () => {
      const perMessage = aggregate({
        table: table(z.object({ id: z.string(), threadId: z.string() }), { key: "id" }),
        inputs: [w.tables.threads, w.tables.messages],
        compute: (q, emit) =>
          q.each(w.tables.threads.all(), (t) =>
            q.each(w.tables.messages.byThread.threadIdEq(t.id), (m) =>
              emit({ id: m.id, threadId: t.id }),
            ),
          ),
      });
      const db = build({ threads: w.tables.threads, messages: w.tables.messages, perMessage });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.run(w.ops.postMessage, { id: "m1", threadId: "t1", body: "a", sentAt: 1 });
      db.run(w.ops.postMessage, { id: "m2", threadId: "t1", body: "b", sentAt: 2 });
      expect(db.read(perMessage.all())).toHaveLength(2);

      db.run(w.ops.removeThread, "t1"); // the messages themselves remain
      expect(db.read(perMessage.all())).toEqual([]);
    });

    it("only notifies subscribers of the output rows that actually changed", async () => {
      const perThread = perThreadCount(() => {});
      const db = build({ threads: w.tables.threads, messages: w.tables.messages, perThread });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.run(w.ops.createThread, { id: "t2", title: "two" });
      await flush();
      let t2Calls = 0;
      db.subscribe(perThread.get("t2"), () => {
        t2Calls++;
      });
      db.run(w.ops.postMessage, { id: "m1", threadId: "t1", body: "a", sentAt: 1 });
      await flush();
      expect(t2Calls).toBe(1); // only the immediate call
    });

    it("reports an error when two scopes emit the same key, keeping the first row", async () => {
      const errors: unknown[] = [];
      const collide = aggregate({
        table: table(z.object({ k: z.string(), from: z.string() }), { key: "k" }),
        inputs: [w.tables.threads],
        compute: (q, emit) =>
          q.each(w.tables.threads.all(), (t) => emit({ k: "same", from: t.id })),
      });
      const db = build({ threads: w.tables.threads, collide }, { onError: (e) => errors.push(e) });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      await flush();
      expect(db.read(collide.get("same"))?.from).toBe("t1");

      db.run(w.ops.createThread, { id: "t2", title: "two" });
      await flush();
      expectReported(errors);
      expect(db.read(collide.get("same"))?.from).toBe("t1"); // t2's scope kept its (empty) output
    });

    it("validates emitted rows, reporting a failure instead of storing the row", async () => {
      const errors: unknown[] = [];
      const bad = aggregate({
        table: table(z.object({ id: z.string(), n: z.number() }), { key: "id" }),
        inputs: [w.tables.threads],
        compute: (q, emit) =>
          q.each(w.tables.threads.all(), (t) => emit({ id: t.id, n: t.title as never })),
      });
      const db = build({ threads: w.tables.threads, bad }, { onError: (e) => errors.push(e) });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      await flush();
      expectReported(errors);
      expect(db.read(bad.get("t1"))).toBeUndefined();
    });
  });

  describe("declaration guards", () => {
    it("reports an error when compute reads a table not in its inputs", async () => {
      const errors: unknown[] = [];
      const bad = aggregate({
        table: table(z.object({ id: z.string(), n: z.number() }), { key: "id" }),
        inputs: [w.tables.threads], // messages deliberately omitted
        compute: (q, emit) =>
          q.each(w.tables.threads.all(), (t) =>
            // @ts-expect-error — reading outside the declared inputs is a type error
            emit({ id: t.id, n: q.read(w.tables.messages.all()).length }),
          ),
      });
      const db = build(
        { threads: w.tables.threads, messages: w.tables.messages, bad },
        { onError: (e) => errors.push(e) },
      );
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      await flush();
      expectReported(errors);
      expect(db.read(bad.get("t1"))).toBeUndefined();
    });

    it("reports an error when a compute function calls an op, without running the op", async () => {
      const errors: unknown[] = [];
      let dbRef: AnyDb | undefined;
      const callsOp = aggregate({
        table: table(z.object({ id: z.string() }), { key: "id" }),
        inputs: [w.tables.threads],
        compute: (q, emit) =>
          q.each(w.tables.threads.all(), (t) => {
            dbRef?.run(w.ops.createThread, { id: "x", title: "y" }); // illegal from compute
            emit({ id: t.id });
          }),
      });
      dbRef = build({ threads: w.tables.threads, callsOp }, { onError: (e) => errors.push(e) });
      dbRef.run(w.ops.createThread, { id: "t1", title: "one" });
      await flush();
      expectReported(errors);
      expect(dbRef.read(w.tables.threads.get("x"))).toBeUndefined();
    });
  });

  describe("compute errors", () => {
    it("keeps previous output, reports to onError, and retries when inputs change", async () => {
      const errors: unknown[] = [];
      let boom = true;
      const flaky = aggregate({
        table: table(z.object({ id: z.string(), title: z.string() }), { key: "id" }),
        inputs: [w.tables.threads],
        compute: (q, emit) =>
          q.each(w.tables.threads.all(), (t) => {
            if (boom && t.title === "bad") throw new Error("compute boom");
            emit({ id: t.id, title: t.title });
          }),
      });
      const db = build({ threads: w.tables.threads, flaky }, { onError: (e) => errors.push(e) });
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.run(w.ops.createThread, { id: "t2", title: "two" });
      await flush();
      expect(db.read(flaky.get("t1"))?.title).toBe("one");

      db.run(w.ops.renameThread, { id: "t1", title: "bad" });
      await flush();
      expect(errors.some((e) => e instanceof Error && e.message === "compute boom")).toBe(true);
      expect(db.read(flaky.get("t1"))?.title).toBe("one"); // kept its previous output
      expect(db.read(flaky.get("t2"))?.title).toBe("two"); // sibling scope unaffected

      boom = false;
      db.run(w.ops.renameThread, { id: "t1", title: "fixed" });
      await flush();
      expect(db.read(flaky.get("t1"))?.title).toBe("fixed"); // retried on input change
    });

    it("reports a q.with error under its parent's path, keeping its previous value", async () => {
      const sources: string[] = [];
      let boom = false;
      const sizes = aggregate({
        table: table(z.object({ threadId: z.string(), n: z.number() }), { key: "threadId" }),
        inputs: [w.tables.threads, w.tables.messages],
        compute: (q, emit) =>
          q.each(w.tables.threads.all(), (t) =>
            emit({
              threadId: t.id,
              n: q.with(w.tables.messages.byThread.threadIdEq(t.id), (ms) => {
                if (boom) throw new Error("with boom");
                return ms.length;
              }),
            }),
          ),
      });
      const db = build(
        { threads: w.tables.threads, messages: w.tables.messages, sizes },
        { onError: (_e, { source }) => sources.push(source) },
      );
      db.run(w.ops.createThread, { id: "t1", title: "one" });
      db.run(w.ops.postMessage, { id: "m1", threadId: "t1", body: "a", sentAt: 1 });
      await flush();

      boom = true;
      db.run(w.ops.postMessage, { id: "m2", threadId: "t1", body: "b", sentAt: 2 });
      await flush();
      expect(sources).toEqual(["c.sizes/t1"]);
      expect(db.read(sizes.get("t1"))?.n).toBe(1);

      boom = false;
      db.run(w.ops.postMessage, { id: "m3", threadId: "t1", body: "c", sentAt: 3 });
      await flush();
      expect(db.read(sizes.get("t1"))?.n).toBe(3); // retried on input change
    });
  });
});
