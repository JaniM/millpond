/// <reference types="node" />
import { afterEach, describe, expect } from "vitest";
import { z } from "zod";
import {
  type AnyDb,
  aggregate,
  count,
  createDb,
  feature,
  type Op,
  op,
  sum,
  table,
} from "../../src/index";

/**
 * Spec suites are the executable acceptance criteria for the engine. They run
 * by default and are RED until the engine is implemented — each `it` fails at
 * fixture construction (the factories throw `not implemented yet`) and goes
 * green as its area lands.
 *
 * Every definition/db is constructed inside `it`/`beforeEach` bodies via the
 * builders below — never at module or `describe` scope — so a failure surfaces
 * per-test rather than breaking collection of the whole file.
 *
 * `spec` is `describe` plus teardown: every db passed through `track` (which
 * `chatWorld().create()` does for you) is disposed after each test, so pending
 * tasks and subscriptions never leak into the next one.
 */
export function spec(name: string, body: () => void): void {
  describe(name, () => {
    afterEach(disposeTracked);
    body();
  });
}

const tracked = new Set<AnyDb>();

/** Registers a db for disposal after the current test. Returns it. */
export function track<D extends AnyDb>(db: D): D {
  tracked.add(db);
  return db;
}

function disposeTracked(): void {
  for (const db of tracked) db.dispose();
  tracked.clear();
}

/**
 * A batch is pending only between a commit and its microtask, so a single
 * `await` lets the flush run (spec §Batching → Testing: "there is no flush()").
 */
export const flush = (): Promise<void> => Promise.resolve();

/** Let queued microtasks and one macrotask settle — for async effect tasks. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A deferred promise, handy for holding an effect's fetch open in a test. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// --- Error assertions --------------------------------------------------------

/**
 * Errors that mean "the engine isn't there yet" or "the engine crashed", as
 * opposed to a deliberate error the spec calls for. A bare `.toThrow()` would
 * accept these and let a test pass for the wrong reason.
 */
const ACCIDENTAL = [
  /not implemented yet/,
  /Cannot read properties of/,
  /Cannot set properties of/,
  /is not a function/,
  /is not iterable/,
  /is not defined/,
];

/** Asserts `err` is a deliberate error, not a stub or a crash. */
export function expectDeliberate(err: unknown): void {
  expect(err, "expected an error").toBeDefined();
  const message = err instanceof Error ? err.message : String(err);
  for (const pattern of ACCIDENTAL) {
    expect(message, "error looks accidental, not deliberate").not.toMatch(pattern);
  }
}

/**
 * Asserts that `fn` throws a deliberate error (see `expectDeliberate`) and
 * returns it. Keep fixture construction outside `fn`, so only the call under
 * test can satisfy the assertion.
 */
export function expectThrows(fn: () => unknown): unknown {
  let thrown = false;
  let error: unknown;
  try {
    fn();
  } catch (e) {
    thrown = true;
    error = e;
  }
  expect(thrown, "expected the call to throw").toBe(true);
  expectDeliberate(error);
  return error;
}

/** Asserts that `errors` holds at least one deliberate error. */
export function expectReported(errors: readonly unknown[]): void {
  expect(errors.length, "expected an error to be reported").toBeGreaterThan(0);
  for (const e of errors) expectDeliberate(e);
}

/**
 * Runs `body`, then lets microtasks and a macrotask settle, capturing every
 * uncaught exception and unhandled rejection raised meanwhile instead of
 * letting vitest fail the run. For the spec's "rethrown from a fresh
 * microtask" paths.
 */
export async function captureUncaught(body: () => void | Promise<void>): Promise<unknown[]> {
  const caught: unknown[] = [];
  const events = ["uncaughtException", "unhandledRejection"] as const;
  const saved = events.map((event) => process.listeners(event));
  const onError = (e: unknown) => {
    caught.push(e);
  };
  for (const event of events) {
    process.removeAllListeners(event);
    process.on(event, onError);
  }
  try {
    await body();
    await settle();
  } finally {
    events.forEach((event, i) => {
      process.off(event, onError);
      for (const listener of saved[i] ?? []) process.on(event, listener as never);
    });
  }
  return caught;
}

// --- The chat domain from the spec, built fresh per test ---------------------

export function chatWorld() {
  const threads = table(
    z.object({
      id: z.string(),
      title: z.string(),
      archived: z.boolean(),
      lastMessageId: z.string().nullable(),
    }),
    { key: "id" },
  );

  const messages = table(
    z.object({
      id: z.string(),
      threadId: z.string(),
      sentAt: z.number(),
      editedAt: z.number().nullable(),
      body: z.string(),
    }),
    { key: "id", indexes: { byThread: ["threadId", "sentAt"] } },
  );

  const reactions = table(
    z.object({
      id: z.string(),
      messageId: z.string(),
      emoji: z.string(),
    }),
    { key: "id", indexes: { byMessage: ["messageId"] } },
  );

  const loadRequests = table(
    z.object({
      id: z.string(),
      threadId: z.string(),
      status: z.enum(["pending", "done", "failed"]),
      error: z.string().nullable(),
    }),
    { key: "id", indexes: { byStatus: ["status"] } },
  );

  // Aggregate: reactions per thread (spec §Aggregates example).
  const threadStats = aggregate({
    table: table(z.object({ threadId: z.string(), reactions: z.number() }), { key: "threadId" }),
    inputs: [threads, messages, reactions],
    compute: (q, emit) =>
      q.each(threads.all(), (thread) =>
        emit({
          threadId: thread.id,
          reactions: q.reduce(
            messages.byThread.threadIdEq(thread.id),
            (msg) => q.reduce(reactions.byMessage.messageIdEq(msg.id), count),
            sum,
          ),
        }),
      ),
  });

  // --- Ops (deterministic: callers pass ids/timestamps) ---
  const createThread = op((tx, t: { id: string; title: string }) => {
    tx.insert(threads, { id: t.id, title: t.title, archived: false, lastMessageId: null });
  });

  const renameThread = op((tx, a: { id: string; title: string }) => {
    tx.update(threads, a.id, { title: a.title });
  });

  const removeThread = op((tx, id: string) => {
    tx.delete(threads, id);
  });

  // Inserts the message AND touches its thread (spec §Ops example).
  const send = op((tx, m: { id: string; threadId: string; body: string; sentAt: number }) => {
    const id = tx.insert(messages, {
      id: m.id,
      threadId: m.threadId,
      body: m.body,
      sentAt: m.sentAt,
      editedAt: null,
    });
    tx.update(threads, m.threadId, { lastMessageId: id as string });
  });

  // Inserts only the message — for tests that must not touch `threads`.
  const postMessage = op(
    (tx, m: { id: string; threadId: string; body: string; sentAt: number }) => {
      tx.insert(messages, { ...m, editedAt: null });
    },
  );

  const editBody = op((tx, a: { id: string; body: string }) => {
    tx.update(messages, a.id, { body: a.body });
  });

  const archive = op((tx, a: { threadId: string }) => {
    for (const m of tx.read(messages.byThread.threadIdEq(a.threadId))) tx.delete(messages, m.id);
    tx.update(threads, a.threadId, { archived: true });
  });

  const addReaction = op((tx, r: { id: string; messageId: string; emoji: string }) => {
    tx.insert(reactions, r);
  });

  const removeReaction = op((tx, id: string) => {
    tx.delete(reactions, id);
  });

  const openThread = op((tx, o: { id: string; threadId: string }) => {
    tx.insert(loadRequests, { id: o.id, threadId: o.threadId, status: "pending", error: null });
  });

  type MessageRow = {
    id: string;
    threadId: string;
    sentAt: number;
    editedAt: number | null;
    body: string;
  };
  const threadLoaded = op((tx, a: { requestId: string; messages: MessageRow[] }) => {
    tx.update(loadRequests, a.requestId, { status: "done" });
    for (const m of a.messages) tx.upsert(messages, m);
  });

  const loadFailed = op((tx, a: { requestId: string; message: string }) => {
    tx.update(loadRequests, a.requestId, { status: "failed", error: a.message });
  });

  const retryLoad = op((tx, a: { requestId: string }) => {
    tx.update(loadRequests, a.requestId, { status: "pending", error: null });
  });

  const ops = {
    createThread,
    renameThread,
    removeThread,
    send,
    postMessage,
    editBody,
    archive,
    addReaction,
    removeReaction,
    openThread,
    threadLoaded,
    loadFailed,
    retryLoad,
  };
  const tables = { threads, messages, reactions, loadRequests, threadStats };

  return {
    tables,
    ops,
    /**
     * Assemble a db from a single `chat` feature. Pass `ops` to register extra
     * test-specific ops (they touch the already-registered tables, so this
     * avoids the "same table under two names" error), plus any createDb flags
     * (`validate`, `freeze`, `onError`, `introspect`). The db is disposed after the test.
     *
     * Without `onError`, reported errors are rethrown as uncaught exceptions
     * (spec §Errors), which fails the vitest run — so a test that provokes an
     * error must pass `onError` or wrap itself in `captureUncaught`.
     */
    create(
      extra: {
        ops?: Record<string, Op>;
        validate?: boolean;
        freeze?: boolean;
        introspect?: boolean | { history?: number };
        onError?: (err: unknown, info: { db: AnyDb; source: string }) => void;
      } = {},
    ): AnyDb {
      const { ops: extraOps = {}, ...flags } = extra;
      const chat = feature({ tables, ops: { ...ops, ...extraOps } });
      return track(createDb({ features: { chat }, ...flags }));
    },
  };
}

export type ChatWorld = ReturnType<typeof chatWorld>;
