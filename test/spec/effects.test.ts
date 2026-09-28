import { beforeEach, expect, it, vi } from "vitest";
import type { AnyDb, Effect, Op } from "../../src/index";
import { createDb, effect, feature, op } from "../../src/index";
import {
  type ChatWorld,
  chatWorld,
  deferred,
  expectReported,
  flush,
  settle,
  spec,
  track,
} from "./harness";

// Spec §"Effects and async tasks".

spec("Effects and async tasks", () => {
  let w: ChatWorld;

  // Ops over loadRequests, reused across tests.
  let markDone: Op<string>;
  let setError: Op<{ id: string; error: string }>;
  let bump: Op<string>;

  beforeEach(() => {
    w = chatWorld();
    markDone = op((tx, id: string) => {
      tx.update(w.tables.loadRequests, id, { status: "done" });
    });
    setError = op((tx, a: { id: string; error: string }) => {
      tx.update(w.tables.loadRequests, a.id, { error: a.error });
    });
    // Touches the row by writing a field back to its current value: status
    // stays "pending" so the row remains in the watched query, and since every
    // update counts as a change, the scope reruns.
    bump = op((tx, id: string) => {
      tx.update(w.tables.loadRequests, id, (r) => ({ threadId: r.threadId }));
    });
  });

  const build = (
    ops: Record<string, Op>,
    effects: Record<string, Effect>,
    opts: { onError?: (e: unknown, i: { db: AnyDb; source: string }) => void } = {},
  ): AnyDb =>
    track(
      createDb({
        features: {
          c: feature({
            tables: { loadRequests: w.tables.loadRequests },
            ops: { openThread: w.ops.openThread, markDone, setError, bump, ...ops },
            effects,
          }),
        },
        ...opts,
      }),
    );

  const pending = () => w.tables.loadRequests.byStatus.statusEq("pending");

  it("starts one task per row of the watched query — but only after the flush", async () => {
    const started = vi.fn();
    const gate = deferred<void>();
    const loadThread = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(pending(), (req) =>
          task(async () => {
            started(req.id);
            await gate.promise;
          }),
        ),
    });
    const db = build({}, { loadThread });

    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    expect(started).not.toHaveBeenCalled(); // not synchronous with the op
    await flush();
    await settle();
    expect(started).toHaveBeenCalledWith("r1");
  });

  it("lets a task write back only through ops", async () => {
    const gate = deferred<void>();
    const loadThread = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(pending(), (req) =>
          task(async ({ run }) => {
            await gate.promise;
            run(markDone, req.id);
          }),
        ),
    });
    const db = build({}, { loadThread });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();
    gate.resolve();
    await settle();
    expect(db.read(w.tables.loadRequests.get("r1"))?.status).toBe("done");
  });

  it("aborts a task when its row leaves the query", async () => {
    const gate = deferred<void>();
    let abortedAfter = false;
    const loadThread = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(pending(), () =>
          task(async ({ signal }) => {
            await gate.promise;
            abortedAfter = signal.aborted;
          }),
        ),
    });
    const db = build({}, { loadThread });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();
    db.run(markDone, "r1"); // row leaves the pending query → scope disposed
    await flush();
    await settle();
    gate.resolve();
    await settle();
    expect(abortedAfter).toBe(true);
  });

  it("restarts a task when its row is updated (default: any field)", async () => {
    const signals: AbortSignal[] = [];
    const gate = deferred<void>();
    const loadThread = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(pending(), () =>
          task(async ({ signal }) => {
            signals.push(signal);
            await gate.promise;
          }),
        ),
    });
    const db = build({}, { loadThread });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();
    db.run(setError, { id: "r1", error: "progress" }); // still pending, but a field changed
    await flush();
    await settle();
    expect(signals).toHaveLength(2); // restarted…
    expect(signals[0]?.aborted).toBe(true); // …after aborting the first run
    expect(signals[1]?.aborted).toBe(false);
  });

  it("starts a new run when a finished task's scope reruns", async () => {
    const starts = vi.fn();
    const loadThread = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(pending(), () =>
          task(async () => {
            starts();
          }),
        ),
    });
    const db = build({}, { loadThread });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle(); // the first run has finished
    db.run(setError, { id: "r1", error: "again" });
    await flush();
    await settle();
    expect(starts).toHaveBeenCalledTimes(2); // aborting the finished run was a no-op
  });

  it("does not restart when the changed field is outside rerunOn (progress reporting)", async () => {
    const starts = vi.fn();
    const gate = deferred<void>();
    const loadThread = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(
          pending(),
          (req) =>
            task(async ({ run }) => {
              starts();
              run(setError, { id: req.id, error: "10%" }); // updates its OWN row, not a rerunOn field
              await gate.promise;
            }),
          { rerunOn: ["threadId"] },
        ),
    });
    const db = build({}, { loadThread });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();
    await settle();
    expect(starts).toHaveBeenCalledTimes(1); // self-update did not restart the task
  });

  it("aborts running tasks on db.dispose()", async () => {
    const gate = deferred<void>();
    let sig: AbortSignal | undefined;
    const loadThread = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(pending(), () =>
          task(async ({ signal }) => {
            sig = signal;
            await gate.promise;
          }),
        ),
    });
    const db = build({}, { loadThread });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();
    db.dispose();
    expect(sig?.aborted).toBe(true);
  });

  it("throws AbortError when an aborted task calls run without ignoreAbort", async () => {
    const gate = deferred<void>();
    let thrown: unknown;
    const loadThread = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(pending(), (req) =>
          task(async ({ run }) => {
            await gate.promise;
            try {
              run(setError, { id: req.id, error: "late" });
            } catch (e) {
              thrown = e;
            }
          }),
        ),
    });
    const db = build({}, { loadThread });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();
    db.run(markDone, "r1"); // abort the task
    await flush();
    await settle();
    gate.resolve();
    await settle();
    expect((thrown as Error | undefined)?.name).toBe("AbortError");
  });

  it("still writes when an aborted task calls run with { ignoreAbort: true }", async () => {
    const gate = deferred<void>();
    const loadThread = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(pending(), (req) =>
          task(async ({ run }) => {
            await gate.promise;
            run(setError, { id: req.id, error: "cleaned" }, { ignoreAbort: true });
          }),
        ),
    });
    const db = build({}, { loadThread });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();
    db.run(markDone, "r1"); // abort
    await flush();
    await settle();
    gate.resolve();
    await settle();
    expect(db.read(w.tables.loadRequests.get("r1"))?.error).toBe("cleaned");
  });

  it("sends an uncaught (non-abort) task error to onError", async () => {
    const errors: unknown[] = [];
    const gate = deferred<void>();
    const loadThread = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(pending(), () =>
          task(async () => {
            await gate.promise;
            throw new Error("task boom");
          }),
        ),
    });
    const db = build({}, { loadThread }, { onError: (e) => errors.push(e) });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();
    gate.resolve();
    await settle();
    expect(errors.some((e) => e instanceof Error && e.message === "task boom")).toBe(true);
  });

  it("does not send abort errors to onError", async () => {
    const errors: unknown[] = [];
    const gate = deferred<void>();
    const loadThread = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(pending(), (req) =>
          task(async ({ run }) => {
            await gate.promise;
            run(setError, { id: req.id, error: "late" }); // throws AbortError, left uncaught
          }),
        ),
    });
    const db = build({}, { loadThread }, { onError: (e) => errors.push(e) });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();
    db.run(markDone, "r1"); // abort
    await flush();
    await settle();
    gate.resolve();
    await settle();
    expect(errors).toHaveLength(0);
  });

  it("disables an effect whose tasks loop past the flush cap", async () => {
    const errors: unknown[] = [];
    const starts = vi.fn();
    // The task updates its own row before ever awaiting. Every update counts as
    // a change, so the scope reruns, aborts this task, and starts another — a
    // loop with no yield to the event loop. The flush cap (100 by default) must
    // break it, disable the effect, and report to onError.
    const loadThread = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(pending(), (req) =>
          task(({ run }) => {
            starts();
            run(bump, req.id); // updates its own row, which reruns and restarts it
          }),
        ),
    });
    const db = build({}, { loadThread }, { onError: (e) => errors.push(e) });

    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await settle(); // let the loop run until the cap halts it

    // It actually looped many times, and the cap stopped it running away.
    const looped = starts.mock.calls.length;
    expect(looped).toBeGreaterThan(1);
    expect(looped).toBeLessThan(1000);
    expect(errors.length).toBeGreaterThan(0); // the loop was reported to onError

    // The effect is disabled for the rest of the db's life: a fresh pending row
    // starts no task.
    starts.mockClear();
    db.run(w.ops.openThread, { id: "r2", threadId: "t2" });
    await settle();
    expect(starts).not.toHaveBeenCalled();
  });

  it("reports an error when watch calls an op, without running the op", async () => {
    const errors: unknown[] = [];
    let dbRef: AnyDb | undefined;
    const loadThread = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(pending(), (req) => {
          dbRef?.run(markDone, req.id); // illegal from watch
          task(async () => {});
        }),
    });
    dbRef = build({}, { loadThread }, { onError: (e) => errors.push(e) });
    dbRef.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();
    expectReported(errors);
    expect(dbRef.read(w.tables.loadRequests.get("r1"))?.status).toBe("pending");
  });

  it("gives tasks a read-only db showing the latest committed state", async () => {
    let seen: unknown;
    const loadThread = effect({
      inputs: [w.tables.loadRequests],
      watch: (q, task) =>
        q.each(
          pending(),
          (req) =>
            task(async ({ db, run }) => {
              run(setError, { id: req.id, error: "progress" });
              seen = db.read(w.tables.loadRequests.get(req.id))?.error;
              // @ts-expect-error — the task's db cannot run ops
              void db.run;
            }),
          { rerunOn: ["status"] },
        ),
    });
    const db = build({}, { loadThread });
    db.run(w.ops.openThread, { id: "r1", threadId: "t1" });
    await flush();
    await settle();
    expect(seen).toBe("progress"); // committed by `run`, visible right away
  });
});
