import { beforeEach, expect, it } from "vitest";
import type { AnyDb } from "../../src/index";
import { type ChatWorld, chatWorld, expectThrows, flush, spec } from "./harness";

// Spec §"Lifecycle and React bindings" (the lifecycle half). Disposing tasks
// is covered in effects.test.ts.

spec("Lifecycle", () => {
  let w: ChatWorld;
  let db: AnyDb;
  beforeEach(() => {
    w = chatWorld();
    db = w.create();
  });

  it("starts with every table empty", () => {
    expect(db.read(w.tables.threads.all())).toEqual([]);
    expect(db.read(w.tables.messages.all())).toEqual([]);
    expect(db.read(w.tables.threadStats.all())).toEqual([]);
  });

  it("throws on reads after dispose()", () => {
    db.dispose();
    expectThrows(() => db.read(w.tables.threads.all()));
  });

  it("throws on ops after dispose()", () => {
    db.dispose();
    expectThrows(() => db.run(w.ops.createThread, { id: "t1", title: "one" }));
  });

  it("throws on new subscriptions after dispose()", () => {
    db.dispose();
    expectThrows(() => db.subscribe(w.tables.threads.all(), () => {}));
  });

  it("treats unsubscribing after dispose() as a silent no-op", () => {
    const stop = db.subscribe(w.tables.threads.all(), () => {});
    db.dispose();
    expect(() => stop()).not.toThrow();
  });

  it("treats a second dispose() as a silent no-op", () => {
    db.dispose();
    expect(() => db.dispose()).not.toThrow();
  });

  it("drops subscriptions on dispose(), even with a batch still pending", async () => {
    let calls = 0;
    db.subscribe(w.tables.threads.all(), () => {
      calls++;
    });
    calls = 0;
    db.run(w.ops.createThread, { id: "t1", title: "one" }); // schedules a flush…
    db.dispose(); // …that must not reach the subscriber
    await flush();
    expect(calls).toBe(0);
  });
});
