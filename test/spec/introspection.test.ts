import { beforeEach, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import type { AnyDb, CreateDbOptions, Effect, Feature, Op, TaskRow } from "../../src/index";
import { aggregate, count, createDb, effect, feature, op, sys, table } from "../../src/index";
import {
  type ChatWorld,
  chatWorld,
  deferred,
  expectDeliberate,
  expectThrows,
  flush,
  settle,
  spec,
  track,
} from "./harness";

// Spec §"Introspection".

spec("Introspection", () => {
  let w: ChatWorld;
  let markDone: Op<string>;
  let bump: Op<string>;

  beforeEach(() => {
    w = chatWorld();
    markDone = op((tx, id: string) => {
      tx.update(w.tables.loadRequests, id, { status: "done" });
    });
    bump = op((tx, id: string) => {
      tx.update(w.tables.loadRequests, id, (r) => ({ threadId: r.threadId }));
    });
  });

  const pending = () => w.tables.loadRequests.byStatus.statusEq("pending");

  /** A db with loadRequests and the given effects, introspecting unless told otherwise. */
  const build = (
    effects: Record<string, Effect>,
    opts: Partial<CreateDbOptions<Record<string, Feature>>> = { introspect: true },
  ): AnyDb =>
    track(
      createDb({
        features: {
          c: feature({
            tables: { loadRequests: w.tables.loadRequests },
            ops: { openThread: w.ops.openThread, markDone, bump },
            effects,
          }),
        },
        ...opts,
      }),
    );

  /** Waits for `gate`, or rejects with the abort error once `signal` fires. */
  const until = (gate: Promise<void>, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      gate.then(resolve);
    });

  /** An effect whose tasks wait on `gate`, honouring their signal, optionally labelled. */
  const gated = (gate: Promise<void>, labelled = false) =>
    effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(pending(), (req) =>
          task(
            async ({ signal }) => {
              await until(gate, signal);
            },
            labelled ? { label: `load ${req.threadId}` } : undefined,
          ),
        ),
    });

  const tasks = (db: AnyDb) => [...db.read(sys.tasks.all())].sort((a, b) => a.id - b.id);

  // --- Opt-in ----------------------------------------------------------------------

  it("is opt-in: without `introspect`, reading a system table throws", () => {
    const db = build({}, {});
    const err = expectThrows(() => db.read(sys.tasks.all()));
    expect(String(err)).toMatch(/introspect/);
    expectThrows(() => db.read(sys.effects.all()));
    expectThrows(() => db.read(sys.tables.all()));
  });

  // --- sys.tables / sys.effects ----------------------------------------------------

  it("lists every registered table and aggregate, but not the system tables", () => {
    const db = w.create({ introspect: true });
    const rows = db.read(sys.tables.all());
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(
      [
        "chat.loadRequests",
        "chat.messages",
        "chat.reactions",
        "chat.threadStats",
        "chat.threads",
      ].sort(),
    );
    const messages = db.read(sys.tables.get("chat.messages"));
    expect(messages).toMatchObject({
      kind: "table",
      key: "id",
      indexes: { byThread: ["threadId", "sentAt"] },
    });
    expect(messages?.table).toBe(w.tables.messages);
    expect(db.read(sys.tables.get("chat.threadStats"))?.kind).toBe("aggregate");
    expect(db.read(sys.tables.byKind.kindEq("aggregate")).map((r) => r.name)).toEqual([
      "chat.threadStats",
    ]);
  });

  it("lets a viewer query any table it finds through the definition value", () => {
    const db = w.create({ introspect: true });
    db.run(w.ops.createThread, { id: "t1", title: "Hello" });
    const row = db.read(sys.tables.get("chat.threads"));
    expect(row && db.read(row.table.all())).toHaveLength(1);
  });

  it("lists every effect with its inputs, state and counters", async () => {
    const gate = deferred<void>();
    const db = build({ load: gated(gate.promise) });
    expect(db.read(sys.effects.get("c.load"))).toMatchObject({
      name: "c.load",
      inputs: ["c.loadRequests"],
      state: "active",
      running: 0,
      started: 0,
      done: 0,
      failed: 0,
      aborted: 0,
    });

    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    db.run(w.ops.openThread, { id: "r2", threadId: "t2" });
    await flush();
    await settle();
    expect(db.read(sys.effects.get("c.load"))).toMatchObject({ running: 2, started: 2 });

    db.run(markDone, "r2"); // aborts r2's task
    gate.resolve();
    await settle();
    expect(db.read(sys.effects.get("c.load"))).toMatchObject({
      running: 0,
      started: 2,
      done: 1,
      aborted: 1,
    });
  });

  // --- sys.tasks lifecycle ---------------------------------------------------------

  it("inserts a running row when a task starts, and marks it done when it finishes", async () => {
    const gate = deferred<void>();
    const db = build({ load: gated(gate.promise) });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();

    const [running] = tasks(db);
    expect(running).toMatchObject({
      effect: "c.load",
      path: "c.load/r1",
      label: "c.load/r1", // no label given → the path
      status: "running",
      abortReason: null,
      restartOf: null,
      note: null,
      error: null,
      endedAt: null,
    });
    expect(typeof running?.id).toBe("number");
    expect(typeof running?.startedAt).toBe("number");

    gate.resolve();
    await settle();
    const [done] = tasks(db);
    expect(done).toMatchObject({ id: running?.id, status: "done" });
    expect(done?.endedAt).toEqual(expect.any(Number));
  });

  it("uses the label passed to task()", async () => {
    const db = build({ load: gated(new Promise(() => {}), true) });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();
    expect(tasks(db)[0]?.label).toBe("load t1");
  });

  it("marks a synchronous task done as soon as it returns", async () => {
    const load = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) => q.each(pending(), () => task(() => {})),
    });
    const db = build({ load });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();
    expect(tasks(db)[0]?.status).toBe("done");
  });

  it("marks a task aborted with `scopeDisposed` when its row leaves the query", async () => {
    const db = build({ load: gated(new Promise(() => {})) });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();
    db.run(markDone, "r1");
    await flush();
    await settle();
    expect(tasks(db)[0]).toMatchObject({ status: "aborted", abortReason: "scopeDisposed" });
    expect(tasks(db)[0]?.endedAt).toEqual(expect.any(Number));
  });

  it("keeps a task that ignores its signal running, with the abort reason set", async () => {
    const gate = deferred<void>();
    const load = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(pending(), () =>
          task(async () => {
            await gate.promise; // ignores signal
          }),
        ),
    });
    const db = build({ load });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();
    db.run(markDone, "r1");
    await flush();
    await settle();
    expect(tasks(db)[0]).toMatchObject({ status: "running", abortReason: "scopeDisposed" });
    expect(db.read(sys.effects.get("c.load"))?.running).toBe(1);

    gate.resolve();
    await settle();
    expect(tasks(db)[0]).toMatchObject({ status: "done", abortReason: "scopeDisposed" });
  });

  it("marks a task done when its own final op disposes its scope", async () => {
    // The spec's worked example: the last op moves the row out of the watched
    // query. That op's flush aborts the task before its promise resolves.
    const load = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(pending(), (req) =>
          task(async ({ run }) => {
            await settle();
            run(markDone, req.id);
          }),
        ),
    });
    const db = build({ load });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();
    await settle();
    expect(tasks(db)[0]).toMatchObject({ status: "done", abortReason: "scopeDisposed" });
  });

  it("links a restarted run to the one it replaced", async () => {
    const db = build({ load: gated(new Promise(() => {})) });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();
    db.run(bump, "r1"); // any update reruns the scope and restarts its task
    await flush();
    await settle();
    const [first, second] = tasks(db);
    expect(first).toMatchObject({ status: "aborted", abortReason: "restarted" });
    expect(second).toMatchObject({ status: "running", restartOf: first?.id, path: "c.load/r1" });
  });

  it("marks a task failed with its error, and still reports it to onError", async () => {
    const reported: unknown[] = [];
    const boom = new Error("boom");
    const load = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(pending(), () =>
          task(async () => {
            throw boom;
          }),
        ),
    });
    const db = build({ load }, { introspect: true, onError: (e) => reported.push(e) });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();
    expect(tasks(db)[0]).toMatchObject({ status: "failed", error: boom, abortReason: null });
    expect(reported).toEqual([boom]);
    expect(db.read(sys.effects.get("c.load"))?.failed).toBe(1);
  });

  it("counts an abort error the task wasn't aborted for as aborted, with no reason", async () => {
    const reported: unknown[] = [];
    const load = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(pending(), () =>
          task(async () => {
            throw new DOMException("its own fetch was aborted", "AbortError");
          }),
        ),
    });
    const db = build({ load }, { introspect: true, onError: (e) => reported.push(e) });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();
    expect(tasks(db)[0]).toMatchObject({ status: "aborted", abortReason: null });
    expect(reported).toEqual([]);
  });

  it("marks tasks aborted with `effectDisabled` and the effect disabled at the flush cap", async () => {
    const load = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(pending(), (req) =>
          task(({ run }) => {
            run(bump, req.id); // restarts itself before ever awaiting
          }),
        ),
    });
    const db = build({ load }, { introspect: true, onError: () => {} });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await settle();
    expect(db.read(sys.effects.get("c.load"))?.state).toBe("disabled");
    expect(db.read(sys.tasks.byStatus.statusEq("running"))).toHaveLength(0);
  });

  // --- note -------------------------------------------------------------------------

  it("sets a note on the task's row, and ignores notes after the task finishes", async () => {
    const step = deferred<void>();
    const finish = deferred<void>();
    let note!: (detail: string | null) => void;
    const load = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(pending(), () =>
          task(async (ctx) => {
            note = ctx.note;
            ctx.note("fetching");
            await step.promise;
            ctx.note("parsing");
            await finish.promise;
          }),
        ),
    });
    const db = build({ load });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();
    expect(tasks(db)[0]?.note).toBe("fetching");
    step.resolve();
    await settle();
    expect(tasks(db)[0]?.note).toBe("parsing");
    finish.resolve();
    await settle();
    note("too late");
    await settle();
    expect(tasks(db)[0]).toMatchObject({ status: "done", note: "parsing" });
  });

  it("makes note a no-op without introspection", async () => {
    const noted = deferred<void>();
    const load = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(pending(), () =>
          task(({ note }) => {
            note("hello");
            noted.resolve();
          }),
        ),
    });
    const db = build({ load }, {});
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await noted.promise; // didn't throw
  });

  // --- Batching and subscriptions ---------------------------------------------------

  it("notifies subscribers of task changes like any other query", async () => {
    const gate = deferred<void>();
    const db = build({ load: gated(gate.promise) });
    const seen: number[] = [];
    db.subscribe(sys.tasks.byStatus.statusEq("running"), (rows) => seen.push(rows.length));
    expect(seen).toEqual([0]);

    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    db.run(w.ops.openThread, { id: "r2", threadId: "t2" });
    await flush();
    await settle();
    expect(seen).toEqual([0, 2]); // both starts land in one batch

    gate.resolve();
    await settle();
    expect(seen.at(-1)).toBe(0);
  });

  it("keeps only the most recent `history` finished runs per effect", async () => {
    const load = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) => q.each(pending(), () => task(() => {})),
    });
    const db = build({ load }, { introspect: { history: 2 } });
    for (const id of ["r1", "r2", "r3", "r4"]) {
      db.run(w.ops.openThread, { id, threadId: id });
      await flush();
      await settle();
    }
    expect(tasks(db).map((t) => t.path)).toEqual(["c.load/r3", "c.load/r4"]);
    expect(db.read(sys.effects.get("c.load"))).toMatchObject({ started: 4, done: 4 });
  });

  // --- Rules ------------------------------------------------------------------------

  it("lets aggregates read system tables", async () => {
    const running = aggregate({
      table: table(z.object({ effect: z.string(), n: z.number() }), { key: "effect" }),
      inputs: [sys.effects, sys.tasks],
      compute: (q, emit) =>
        q.each(sys.effects.all(), (e) =>
          emit({
            effect: e.name,
            n: q.reduce(sys.tasks.byEffect.effectEq(e.name).statusEq("running"), count),
          }),
        ),
    });
    const db = track(
      createDb({
        features: {
          c: feature({
            tables: { loadRequests: w.tables.loadRequests, running },
            ops: { openThread: w.ops.openThread },
            effects: { load: gated(new Promise(() => {})) },
          }),
        },
        introspect: true,
      }),
    );
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();
    expect(db.read(running.get("c.load"))?.n).toBe(1);
  });

  it("rejects a system table as an effect input", () => {
    const watcher = effect({
      inputs: [sys.tasks],
      watch: (q, task) => q.each(sys.tasks.all(), () => task(() => {})),
    });
    expectThrows(() =>
      createDb({ features: { c: feature({ effects: { watcher } }) }, introspect: true }),
    );
  });

  it("makes system tables read-only to ops", () => {
    const forge = op((tx) => {
      tx.delete(sys.tasks, 1);
    });
    const db = track(createDb({ features: { c: feature({ ops: { forge } }) }, introspect: true }));
    expectThrows(() => db.run(forge, undefined));
  });

  it("rejects registering a system table in a feature", () => {
    let err: unknown;
    try {
      createDb({ features: { c: feature({ tables: { tasks: sys.tasks } }) }, introspect: true });
    } catch (e) {
      err = e;
    }
    expectDeliberate(err);
  });

  // --- Types ------------------------------------------------------------------------

  it("types the system rows", () => {
    expectTypeOf<TaskRow["status"]>().toEqualTypeOf<"running" | "done" | "failed" | "aborted">();
    expectTypeOf<TaskRow["abortReason"]>().toEqualTypeOf<
      "restarted" | "scopeDisposed" | "effectDisabled" | null
    >();
    const q = sys.tasks.byEffect.effectEq("x").statusEq("running");
    expectTypeOf(q).toMatchTypeOf<{ readonly kind: "query" }>();
  });
});
