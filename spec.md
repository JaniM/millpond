# Reactive DB — Design Spec

Sep 28, 2026 · @Jani Mustonen

## Overview

An in-memory database for TypeScript apps where every write goes through a predefined op and every query can be subscribed to.

- **Tables** have a static schema (any Standard Schema, such as Zod), a single-field primary key and named indexes.
- **Queries** read one table through one index, and can be read once or subscribed to.
- **Ops** are the only way to write: synchronous transactions, defined up front.
- **Aggregates** are derived, read-only tables maintained incrementally from other tables. They take the place of joins.
- **Effects** run async tasks, one per row of a query, and write back only by calling ops.

&#91;embedded content: data flow · ops write, everything else reacts\]

Aggregates, subscribers and effects all react after an op commits. Effect tasks close the loop only through ops, so there is exactly one write path.

**Non-goals:** replication or server sync, persistence and snapshots, joins inside queries, guaranteed result order, async ops, and registering definitions after the db is created.

## Definitions and features

Every table, aggregate, op and effect is a standalone exported value, and definitions depend on each other through ordinary imports. Features group definitions, and `createDb` assembles features.

```ts
// chat/ops.ts
export const send = op((tx, m: { threadId: string; body: MessageBody }) => {
  tx.insert(messages, { ...m, sentAt: Date.now(), editedAt: null });
});

// chat/index.ts
export const chat = feature({
  tables: { threads, messages, loadRequests, threadStats }, // aggregates are tables too
  ops: { send, archive, threadLoaded },
  effects: { loadThread },
});

// db.ts
export const db = createDb({
  features: { users, chat, logs },
  validate: true, // the default
  freeze: true,   // the default
  onError: (err, { db, source }) => db.ops.logs.record({ message: String(err), source }),
});

db.ops.chat.send({ threadId: "t1", body });
```

### Naming and dispatch

- **Names come from registration.** A definition never knows its own name. It is named by the feature key plus its key inside the feature, such as `chat.send`, so names are unique by construction and `users.send` can coexist with `chat.send`.
- **Dispatch is by identity.** `createDb` builds a map from each definition value to its registered entry. `tx.run(send, args)` looks up `send` in that map; the name is only used for `db.ops.chat.send`, error messages and devtools.
- **Features never import the assembled db.** Code inside a feature calls ops by value, with `db.run(send, args)`, `tx.run(send, args)` or `useOp(send)`, and the op's types travel with the value. `db.ops.<feature>.<op>()` is the convenience form for app-level code.
- **Definitions are not tied to a db.** The same features can back several db instances, for example one per test.
- **Everything is registered at creation.** Definitions cannot be added or removed afterwards.

### Registration checks

| Mistake | Caught |
| --- | --- |
| Aggregate or effect input that isn't registered | Type error, and `createDb` throws |
| Same definition registered under two names | `createDb` throws |
| Op touches an unregistered table | Throws when the op runs |
| `tx.run` or `db.run` with an unregistered op | Throws when called |

## Tables and schemas

A table is an object schema plus a single-field primary key and named indexes. Schemas use Standard Schema, which Zod, Valibot and ArkType all implement, so none of them is a hard dependency.

```ts
export const messages = table(z.object({
  id: z.string(),
  threadId: z.string(),
  sentAt: z.number(),
  editedAt: z.number().nullable(),
  body: MessageBody, // any schema, but not indexable
}), {
  key: "id",
  generate: () => crypto.randomUUID(), // optional
  indexes: { byThread: ["threadId", "sentAt"] },
});
```

- **Row type** is the schema's output type.
- **Primary key** is one primitive field and is always indexed.
- **Key generator** is optional. With one, the key becomes optional in `insert`'s type. A key the caller provides always wins, and `insert` returns the key.
- **Indexes** are named column lists that act as composite keys. Key and index columns must be string, number, boolean or nullable versions of these, which the types enforce. Nulls sort first.
- **Schemas only validate.** A row is stored exactly as given. Schemas with defaults or transforms, where input and output types differ, are rejected, because an update would re-run a transform on an already-transformed row. Async schemas throw when used, since ops are synchronous.
- **Validation** runs on every write, including aggregate output. A failure throws and rolls back the op. It is on by default, and `createDb({ validate: false })` turns it off.
- **Rows are immutable,** including any nested values. Updates produce new row objects, and every update counts as a change, even when the new values are identical.
- **Freezing** shallow-freezes every stored row, so assigning to a row's field throws. Nested objects aren't frozen, but mutating them is still unsupported. It is on by default, and `createDb({ freeze: false })` turns it off.

## Queries and subscriptions

A query reads one table through one index: equality on a prefix of the index columns, then optionally a comparison on the next column. Queries are plain values that don't belong to any db.

```ts
messages.all()                                // every row
messages.get("m1")                            // one row by key, or undefined
messages.byThread.threadIdEq("t1")            // prefix: all of thread t1
messages.byThread.threadIdEq("t1").sentAtGte(from).sentAtLt(to) // prefix, then a range

db.read(messages.byThread.threadIdEq("t1"));  // one-shot read
const stop = db.subscribe(messages.byThread.threadIdEq("t1"), (rows) => render(rows));
```

- **Field-named methods.** Each step offers methods named after the next index column: `<field>Eq` for equality, and `<field>Gt`, `<field>Gte`, `<field>Lt` and `<field>Lte` for comparisons. They are generated when the table is defined and typed with template literal types, so autocomplete shows only the valid next column. A comparison ends the prefix, and a lower and an upper bound on the same field together form a range.
- **Results** are readonly arrays in unspecified order, in practice whatever the index scan yields. `get` returns a row or `undefined`.
- **Structural identity.** A query is identified by its table, index, prefix values and range. Equal queries share one subscription and one cached result, so a component that rebuilds its query every render still gets the same array.
- **Stable results.** A result that hasn't changed keeps the same array object.
- **Subscribe.** The callback runs immediately with the current result, then once per flush in which a row in the result was added, removed or changed. `subscribe` returns an unsubscribe function.
- **Subscribers never write.** Calling an op from a subscriber callback throws.
- **Reads outside ops** see all committed data. Reading an aggregate first brings it up to date (see Batching and consistency).
- **Implementation.** Each index is a sorted structure such as a B-tree, so prefix and range scans are cheap. Watchers are registered by prefix, so a write finds the affected subscriptions and scopes with one hash lookup per prefix length.

## Ops

An op is a synchronous function of a transaction and its arguments. It commits all of its writes, or, if it throws, none of them, and the error is rethrown to the caller.

```ts
export const send = op((tx, m: { threadId: string; body: MessageBody }) => {
  const id = tx.insert(messages, { ...m, sentAt: Date.now(), editedAt: null });
  tx.update(threads, m.threadId, { lastMessageId: id });
});

export const archive = op((tx, { threadId }: { threadId: string }) => {
  for (const m of tx.read(messages.byThread.threadIdEq(threadId))) tx.delete(messages, m.id);
  tx.update(threads, threadId, { archived: true });
});
```

| Call | Does | Throws when |
| --- | --- | --- |
| `tx.insert(table, row)` | Inserts the row and returns its key | The key exists, or validation fails |
| `tx.update(table, key, patch)` | Shallow-merges the patch into a new row | The key is missing, the patch changes the key, or validation fails |
| `tx.update(table, key, (row) => patch)` | Same, with the patch computed from the current row, which is guaranteed to exist | Same as above |
| `tx.upsert(table, row)` | Inserts or replaces, and returns the key | Validation fails |
| `tx.delete(table, key)` | Deletes the row | The key is missing |
| `tx.read(query)` | Reads, including the op's own writes | Only the shared cases below |
| `tx.run(op, args)` | Runs another op inline as a savepoint | The nested op throws |

Every call also throws when its table or op isn't registered, or when it writes to an aggregate table.

- **Nested ops are savepoints.** If a nested op throws and the caller catches the error, only the nested op's writes are undone.
- **Ops return nothing.** `insert` and `upsert` return keys so an op can link related rows. An op that returns a promise throws.
- **Aggregates inside an op** reflect everything committed before the op started. They never include the op's own writes, which would mean rolling back aggregate state whenever the op throws.
- **Calling ops:** `db.ops.chat.send(args)` or `db.run(send, args)` from app code, `tx.run` inside ops, `run` inside effect tasks, and `useOp(send)` in React components.
- **Where ops can't be called:** subscriber callbacks and aggregate compute functions. Both throw.

## Aggregates

An aggregate is its own read-only table, computed from declared inputs by a tree of scopes. When data changes, only the scopes that read it are recomputed.

```ts
export const threadStats = aggregate({
  table: table(z.object({ threadId: z.string(), reactions: z.number() }), { key: "threadId" }),
  inputs: [threads, messages, reactions],
  compute: (q, emit) =>
    q.each(threads.all(), (thread) => emit({
      threadId: thread.id,
      reactions: q.reduce(
        messages.byThread.threadIdEq(thread.id),
        (msg) => q.reduce(reactions.byMessage.messageIdEq(msg.id), count),
        sum,
      ),
    })),
});
```

### Declaring

- **Inputs** list every table and aggregate the compute function may read. Reading anything else is a type error and throws at runtime.
- **No cycles.** Inputs must already exist where the aggregate is defined, so cycles are impossible, and `createDb` orders aggregates by their inputs.
- **Pure compute.** Compute functions read only through `q` and cannot call ops; calling one throws.
- **Registration.** An aggregate is registered under a feature's `tables`, like any other table.

### Scopes

- `q.each(query, fn)` calls `fn` once per row, each in its own scope keyed by the row's primary key, and returns the array of results.
- `q.reduce(query, fn, reducer)` does the same, but folds the results with a reducer. The mapping function is optional: `q.reduce(query, reducer)` folds the rows themselves, so `q.reduce(query, count)` counts rows.
- `q.read(query)` reads a query inside the current scope.
- Any callback can call these again, so scopes nest to any depth.
- `q.each` and `q.reduce` take an optional `{ rerunOn: [...fields] }`. Only changes to the listed fields rerun a row's scope; without the option, any change does. The list is type-checked against the row.
- The row a scope receives is a snapshot as of its last rerun.

### What reruns

- **Reads are tracked.** A change reruns only the scopes whose reads it touched.
- **Changes stop early.** A scope that reruns with a new return value, compared with `Object.is`, marks its parent to rerun. If the value is unchanged, nothing above it reruns.
- **Iterated queries apply as diffs.** New rows get new scopes, removed rows dispose of theirs, and unchanged rows keep cached results. Changed rows rerun theirs, unless the scope has `rerunOn` and none of the listed fields changed.
- **Captured values.** If any other input of a parent changes, all of its children rerun, since they may have captured that value.
- **Cost.** When a child changes, `each` costs its parent work proportional to the group size. `reduce` costs constant time with `count` and `sum`, and O(log n) with `min` and `max`.

&#91;embedded content: scope tree for threadStats · one reaction added\]

The new reaction changes m2's read, so m2 reruns and returns a new count. That makes t1 rerun and re-emit its row, while m1, t2 and m3 keep their cached results.

### Reducers

A reducer is `{ init, add, remove, result? }`. When a child's value changes, the engine calls `remove` with the old value, then `add` with the new one.

The accumulator is private to the engine, so a reducer may mutate it in place. The optional `result(acc)` produces the value that `q.reduce` returns, which is compared with `Object.is` to decide whether the parent reruns. Without `result`, the accumulator itself is the value, so a reducer that mutates its accumulator must provide `result`.

`count`, `sum`, `min` and `max` are built in. `min` and `max` keep every child's value in a sorted structure, so they use memory proportional to the group, cost O(log n) per change, and return `undefined` for an empty group.

### Output

- **Scopes own their rows.** `emit(row)` can be called from any scope, any number of times, and the rows belong to that scope.
- **Only differences are written.** After a scope reruns, its new output is diffed against its previous output by primary key.
- **Disposal cascades.** Disposing a scope removes its rows and the rows of every scope nested under it.
- **Duplicate keys.** Two scopes emitting the same key is an error, reported like a compute error.

### Errors

If a compute function throws, the scope keeps its previous output, the error goes to `onError` after the flush, and the scope retries when its inputs next change.

## Effects and async tasks

All async work lives in effects, which run one task per scope, usually one per row of a query. Tasks write back only through ops, so loading, error and retry states are ordinary rows the UI can subscribe to.

```ts
export const loadThread = effect({
  inputs: [loadRequests],
  watch: (q, task) =>
    q.each(loadRequests.byStatus.statusEq("pending"), (req) =>
      task(async ({ db, run, signal }) => {
        try {
          const res = await fetch(`/threads/${req.threadId}`, { signal });
          run(threadLoaded, { requestId: req.id, data: await res.json() });
        } catch (err) {
          if (!signal.aborted) run(loadFailed, { requestId: req.id, message: String(err) });
        } finally {
          if (signal.aborted) run(releaseSlot, { requestId: req.id }, { ignoreAbort: true });
        }
      })),
});
```

`watch` uses the same scopes as an aggregate's compute function: it nests to any depth, reads only its declared inputs, and cannot call ops.

| When | The task |
| --- | --- |
| Its scope is created, such as a row entering the query | Starts |
| Its scope reruns, such as its row being updated in a field `rerunOn` covers | Is aborted, and a new run starts |
| Its scope is disposed, such as its row leaving the query | Is aborted |
| `db.dispose()` is called | Is aborted |

Aborting a task that has already finished does nothing.

- **Tasks start after the flush.** An op a task calls, even before its first `await`, lands in a new batch.
- **Task context.** `db` is a read-only view showing the latest committed state, like any outside code. `run(op, args)` is the only way to write, and `signal` fires when the task is aborted. `note(detail)` sets a debugging note on the task's `sys.tasks` row (see Introspection).
- **Labels.** `task(fn, { label })` gives the task a human-readable name for introspection. Without one, the task is labelled with its scope's path.
- **Aborted tasks can't write.** After an abort, `run` throws an `AbortError`, which also stops the task. `run(op, args, { ignoreAbort: true })` skips that check, for cleanup.
- **Errors.** Tasks handle their own errors. Uncaught errors go to `onError`, except abort errors.
- **Restart loops.** A task that updates its own row restarts itself, unless its scope has `rerunOn` and the fields it writes aren't listed. If that happens before the task's first `await`, it loops without ever yielding to the browser, so consecutive flushes are capped, 100 by default. When the cap is hit, every effect caught in the loop is disabled for the rest of the db's life: its tasks are aborted, no new ones start, and the error goes to `onError`.

### Updates that don't restart a task

By default, any update to a scope's row restarts its task. `rerunOn` narrows that to the listed fields, so a task can report progress on its own row:

```ts
q.each(downloads.byStatus.statusEq("pending"), (dl) =>
  task(async ({ run, signal }) => {
    const res = await fetch(dl.url, { signal });
    for await (const loaded of trackProgress(res)) {
      run(reportProgress, { downloadId: dl.id, loaded }); // updates dl's own row
    }
    run(downloadDone, { downloadId: dl.id });
  }),
  { rerunOn: ["url"] },
);
```

Updating `loaded` leaves the task running, and changing `url` restarts it. `downloadDone` moves the row out of the pending query, which disposes the scope as usual. Because `dl` is a snapshot, a task that needs current values reads them through `db`.

## Batching and consistency

Ops commit immediately. Everything that reacts to them runs once per batch, in a flush scheduled on a microtask.

### From commit to flush

1. **Commit.** A successful op's changes merge into the pending changeset, keyed by table and primary key. Each row keeps its first before-value and its last after-value, so an insert followed by a delete in the same batch cancels out. The first commit of a batch schedules the flush with `queueMicrotask`.
2. **Aggregates.** Dirty aggregates are brought up to date in dependency order. Each recomputes only the scopes its input changes touched, and its output diff feeds the aggregates downstream.
3. **Subscribers.** Each subscription whose result changed is called once, with its new result.
4. **Effects.** Effect scopes are updated, and their tasks are started, restarted or aborted.
5. **Errors.** Errors collected during the flush are delivered to `onError`. Ops it calls start a new batch.

### Why a microtask

- **Batching.** A burst of ops, such as an event handler calling three ops or a loop importing 1,000 messages, causes one recompute per affected group and one render, not one per op.
- **Coalescing.** Changes that cancel out within a batch never reach anyone.
- **No stale paint.** A microtask runs before the browser paints or handles the next event, so the UI never shows a stale frame.
- **No reentrancy.** Callbacks never run in the middle of the code that called the op.

### Aggregates catch up on read

Between a commit and its flush, base tables are current but aggregates may not be. Any read of an aggregate in that window, from an op, a task or outside code, first brings that aggregate and the ones upstream of it up to date.

Reads therefore stay consistent, and when nothing reads in between, which is the common case, the work still happens once per batch. The worst case, a read after every op, costs the same as recomputing after every op. Inside an op, aggregates reflect the state as of the op's start (see Ops).

### Testing

There is no `flush()`. A batch is pending only between a commit and its microtask, so a single `await` in a test lets it run.

## Errors

Errors are loud: every mistake either throws to the code that caused it or is reported to `onError`. Nothing fails silently.

| Error | What happens |
| --- | --- |
| An op throws, including a failed validation or a duplicate or missing key | Its writes roll back, and the error is rethrown to the caller |
| A nested op throws | Its writes are undone, and the calling op decides whether to catch |
| An op is called from a subscriber, a compute function or a `watch` function | Throws |
| A compute function throws, or two scopes emit the same key | The scope keeps its previous output, the error goes to `onError`, and the scope retries when its inputs change |
| A subscriber throws | Goes to `onError`, and the other subscribers are still called |
| A task doesn't catch an error | Goes to `onError`, unless it is an abort error |
| An aborted task calls `run` without `ignoreAbort` | Throws an `AbortError` inside the task |
| An effect's tasks loop past the flush cap | The effect is disabled for good: its tasks are aborted, no new ones start, and the error goes to `onError` |

Registration mistakes and unregistered tables or ops are covered under Definitions and features.

`onError(err, { db, source })` runs after the flush, so it can call ops, for example to record the error as a row. `source` gives the registered name of what failed, such as `chat.threadStats`, plus the key path of the scope or task when there is one.

`onError` is optional, and errors never go back into it. If it throws, its error is rethrown from a fresh microtask with the original error as its `cause`. If no `onError` is given, each reported error is rethrown the same way. Either way the platform's global error handling picks it up: `window.onerror` and the console in browsers, or an uncaught exception in Node. The db itself stays consistent, since the flush has already finished.

## Introspection

A db can describe itself through built-in, read-only system tables. They are queried like any other table, so `read`, `subscribe`, `useQuery`, batching and stable results all apply, and devtools need no separate API.

```ts
import { createDb, sys } from "reactive-db";

const db = createDb({ features, introspect: true }); // or { history: 50 }

db.subscribe(sys.tasks.byStatus.statusEq("running"), render);
useQuery(sys.tasks.byEffect.effectEq("chat.loadRoom"));
useQuery(sys.effects.all());
useQuery(sys.tables.all());
```

Introspection is opt-in. Without `introspect`, nothing is tracked and reading a system table throws with a hint to turn it on.

### System tables

**`sys.tasks`** has one row per task run, keyed by `id`, with indexes `byEffect: ["effect", "status"]` and `byStatus: ["status"]`.

| Field | Meaning |
| --- | --- |
| `id` | A number, increasing with each run, unique within the db |
| `effect` | The effect's registered name, such as `chat.loadRoom` |
| `path` | The task's scope path, the same string `onError` receives as `source` |
| `label` | From `task(fn, { label })`, or `path` when none is given |
| `status` | How the task's code settled: `"running"`, `"done"`, `"failed"` or `"aborted"` |
| `abortReason` | Why the engine aborted the task, if it did: `"restarted"`, `"scopeDisposed"` or `"effectDisabled"`, otherwise `null` |
| `restartOf` | The id of the run this one replaced when its scope reran, otherwise `null` |
| `note` | The last value passed to `ctx.note`, initially `null` |
| `error` | What a failed task threw, otherwise `null` |
| `startedAt`, `endedAt` | Timestamps from `Date.now()`; `endedAt` is `null` while running |

**`sys.effects`** has one row per registered effect, keyed by `name`: its `inputs` (registered table names), `state` (`"active"`, or `"disabled"` after the flush cap), and counters `running`, `started`, `done`, `failed` and `aborted`.

**`sys.tables`** has one row per registered table and aggregate, keyed by `name`, with index `byKind: ["kind"]`: its `kind` (`"table"` or `"aggregate"`), `key` field, `indexes` (name to columns), and `table`, the definition value itself, so a viewer can query any table it finds with `row.table.all()`. System tables do not list themselves.

### Task lifecycle

`status` records what the task's code did, and `abortReason` records what the engine did to it. They are separate because an abort and the task's own ending race each other.

- **Running** from when the task starts, after the flush, until its function returns or its promise settles. A task cancelled before it started never gets a row.
- **Done** when its function returns or its promise resolves.
- **Failed** when it throws or rejects with anything but an abort error. The error is stored in `error` and, as before, reported to `onError`.
- **Aborted** when it throws or rejects with an abort error. That includes the `AbortError` that `run` throws after an abort, and a `fetch` or timer that honours `signal`.
- **`abortReason`** is set the moment the engine aborts the task, and kept after the task settles. Aborting a task that has already settled does nothing, as before.

Reading the two together:

| `status` | `abortReason` | Meaning |
| --- | --- | --- |
| `running` | `null` | Working |
| `running` | set | Told to stop, but hasn't yet, for example because it awaits something that ignores `signal` |
| `aborted` | set | Stopped by the engine |
| `done` | set | Finished anyway, typically because its own final op moved its row out of the query, and the resulting flush aborted it before its promise resolved |
| `aborted` | `null` | Rejected with an abort error the engine didn't cause, such as its own timeout |

`note` calls are ignored once a task has settled.

### Rules

- **Only the engine writes.** System rows are written by the engine, never by ops, so writing to a system table from an op throws, like writing to an aggregate. System rows are not validated.
- **Batched like everything else.** A lifecycle change marks the affected queries dirty and schedules a flush, as a commit does. Changes made during a flush, such as tasks starting, are delivered by the next flush, which does not count toward the effect flush cap.
- **Aggregates may read system tables; effects may not.** An effect watching `sys.tasks` would restart on its own task's row, so declaring a system table as an effect input makes `createDb` throw. Aggregates cannot write, so they are safe.
- **History is bounded.** Running tasks are always kept. For each effect, only the most recent `history` finished runs are kept (20 by default), and older rows are deleted.
- **Reserved.** Registering a system table in a feature makes `createDb` throw.

## Lifecycle and React bindings

A db lives in memory from `createDb` until `dispose()`, with no persistence or snapshots.

- **Creation.** `createDb` checks the registrations and starts with every table empty. Initial data is loaded by calling ops.
- **Disposal.** `db.dispose()` aborts every task and drops every subscription. Afterwards, ops, reads and new subscriptions throw, since using a disposed db is almost always a bug. Cleanup calls, meaning unsubscribing and calling `dispose()` again, are silent no-ops, because teardown order is unpredictable: React may unsubscribe after the db is gone.

### React

```tsx
function Thread({ threadId }: { threadId: string }) {
  const rows = useQuery(messages.byThread.threadIdEq(threadId));
  const stats = useQuery(threadStats.get(threadId));
  const sendMessage = useOp(send);
  return (
    <MessageList
      messages={rows}
      reactions={stats?.reactions}
      onSend={(body) => sendMessage({ threadId, body })}
    />
  );
}

// at the root
<DbProvider db={db}><App /></DbProvider>
```

- **`useQuery`** is built on `useSyncExternalStore`. Because equal queries share a subscription and unchanged results keep the same array, a component can rebuild its query every render at no cost.
- **`useOp(op)`** returns a function bound to the provider's db. Its types come from the op value, so components never import the assembled db.
- **Other frameworks** will get bindings later, built on the same `subscribe` API.

## Worked example: loading a chat thread

Opening a thread inserts a request row. An effect fetches the thread, and an op writes the result, so every step is visible as data. `messages` comes from Tables and schemas, `send` from Ops, and `threadStats` from Aggregates.

```ts
// chat/tables.ts
const id = () => crypto.randomUUID();

export const threads = table(z.object({
  id: z.string(),
  title: z.string(),
  archived: z.boolean(),
  lastMessageId: z.string().nullable(),
}), { key: "id", generate: id });

export const reactions = table(z.object({
  id: z.string(),
  messageId: z.string(),
  emoji: z.string(),
}), { key: "id", generate: id, indexes: { byMessage: ["messageId"] } });

export const loadRequests = table(z.object({
  id: z.string(),
  threadId: z.string(),
  status: z.enum(["pending", "done", "failed"]),
  error: z.string().nullable(),
}), { key: "id", generate: id, indexes: { byStatus: ["status"] } });

// chat/ops.ts
export const openThread = op((tx, { threadId }: { threadId: string }) => {
  tx.insert(loadRequests, { threadId, status: "pending", error: null });
});

export const threadLoaded = op((tx, a: { requestId: string; data: ThreadData }) => {
  tx.update(loadRequests, a.requestId, { status: "done" });
  for (const m of a.data.messages) tx.upsert(messages, m);
});

export const loadFailed = op((tx, a: { requestId: string; message: string }) => {
  tx.update(loadRequests, a.requestId, { status: "failed", error: a.message });
});

export const retryLoad = op((tx, { requestId }: { requestId: string }) => {
  tx.update(loadRequests, requestId, { status: "pending", error: null });
});

// chat/effects.ts
export const loadThread = effect({
  inputs: [loadRequests],
  watch: (q, task) =>
    q.each(loadRequests.byStatus.statusEq("pending"), (req) =>
      task(async ({ run, signal }) => {
        try {
          const res = await fetch(`/threads/${req.threadId}`, { signal });
          run(threadLoaded, { requestId: req.id, data: await res.json() });
        } catch (err) {
          if (!signal.aborted) run(loadFailed, { requestId: req.id, message: String(err) });
        }
      })),
});

// chat/index.ts
export const chat = feature({
  tables: { threads, messages, reactions, loadRequests, threadStats },
  ops: { openThread, threadLoaded, loadFailed, retryLoad, send },
  effects: { loadThread },
});
```

What happens when a user opens a thread:

1. The component calls `useOp(openThread)`, which inserts a pending `loadRequests` row.
2. At the flush, the row enters `loadThread`'s query, so a task starts fetching.
3. The task calls `run(threadLoaded, …)`. In one transaction, the request is marked done and the messages are upserted.
4. The next flush updates `threadStats` for that thread only and re-renders the components watching its messages or stats. The request has left the pending query, so its finished task is disposed.
5. On failure, the request row holds the error for the UI to show. `retryLoad` sets it back to pending, which starts a new task.
