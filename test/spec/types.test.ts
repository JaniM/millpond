import { expectTypeOf, it } from "vitest";
import { z } from "zod";
import { aggregate, count, effect, op, type TaskContext, table } from "../../src/index";
import type { useOp } from "../../src/react";
import { chatWorld, spec } from "./harness";

// The spec's type-level promises. These run like any spec test (and fail at
// fixture construction until the engine lands), but their real assertions are
// checked by `pnpm typecheck:spec`: `expectTypeOf` and `@ts-expect-error`.

spec("Types", () => {
  it("query builders offer only the next index column, via field-named methods", () => {
    const { messages } = chatWorld().tables;
    expectTypeOf(messages.byThread).toHaveProperty("threadIdEq");
    expectTypeOf(messages.byThread.threadIdEq("t1")).toHaveProperty("sentAtGte");
    // @ts-expect-error — sentAt is not the first column of byThread
    void messages.byThread.sentAtEq;
    // @ts-expect-error — no such index column
    void messages.byThread.bodyEq;
  });

  it("reads are typed by the query: readonly rows, or a row or undefined for get", () => {
    const w = chatWorld();
    const db = w.create();
    type Message = {
      id: string;
      threadId: string;
      sentAt: number;
      editedAt: number | null;
      body: string;
    };
    expectTypeOf(db.read(w.tables.messages.all())).toEqualTypeOf<readonly Message[]>();
    expectTypeOf(db.read(w.tables.messages.get("m1"))).toEqualTypeOf<Message | undefined>();
  });

  it("key and index columns must be indexable primitives", () => {
    const schema = z.object({ id: z.string(), tags: z.array(z.string()) });
    // @ts-expect-error — an array cannot be a primary key
    table(schema, { key: "tags" });
    // @ts-expect-error — nor an index column
    table(schema, { key: "id", indexes: { byTags: ["tags"] } });
  });

  it("a key generator makes the key optional in insert, which returns the key", () => {
    const generated = table(z.object({ id: z.string(), n: z.number() }), {
      key: "id",
      generate: () => "x",
    });
    const plain = table(z.object({ id: z.string(), n: z.number() }), { key: "id" });
    op((tx) => {
      expectTypeOf(tx.insert(generated, { n: 1 })).toEqualTypeOf<string>();
      // @ts-expect-error — without a generator the key is required
      tx.insert(plain, { n: 1 });
    });
  });

  it("aggregate compute may read only its declared inputs", () => {
    const { threads, messages } = chatWorld().tables;
    aggregate({
      table: table(z.object({ id: z.string(), n: z.number() }), { key: "id" }),
      inputs: [threads],
      compute: (q, emit) =>
        q.each(threads.all(), (t) =>
          // @ts-expect-error — messages is not an input
          emit({ id: t.id, n: q.reduce(messages.byThread.threadIdEq(t.id), count) }),
        ),
    });
  });

  it("rerunOn is checked against the row's fields", () => {
    const { threads } = chatWorld().tables;
    aggregate({
      table: table(z.object({ id: z.string() }), { key: "id" }),
      inputs: [threads],
      compute: (q, emit) => {
        q.each(threads.all(), (t) => emit({ id: t.id }), { rerunOn: ["title"] });
        // @ts-expect-error — not a field of the thread row
        q.each(threads.all(), (t) => emit({ id: t.id }), { rerunOn: ["nope"] });
      },
    });
  });

  it("tasks get a read-only db and write only through run", () => {
    expectTypeOf<TaskContext["db"]>().not.toHaveProperty("run");
    const { loadRequests } = chatWorld().tables;
    effect({
      inputs: [loadRequests],
      watch: (q, task) =>
        q.each(loadRequests.all(), () =>
          task(async ({ db }) => {
            // @ts-expect-error — the task's db is read-only
            db.run(
              op(() => {}),
              undefined,
            );
          }),
        ),
    });
  });

  it("ops carry their argument types to every call site", () => {
    const w = chatWorld();
    const db = w.create();
    type SendArgs = { id: string; threadId: string; body: string; sentAt: number };
    expectTypeOf<ReturnType<typeof useOp<SendArgs>>>().toEqualTypeOf<(args: SendArgs) => void>();
    const call = () => {
      // @ts-expect-error — missing sentAt
      db.run(w.ops.send, { id: "m1", threadId: "t1", body: "hi" });
    };
    void call;
  });
});
