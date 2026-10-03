# millpond

> ⚠️ **Status: scaffold.** The public API is fully typed and exported, but the
> engine is not implemented yet — the factories (`table`, `op`, `aggregate`,
> `effect`, `feature`, `createDb`) throw `not implemented yet`. The built-in
> reducers (`count`, `sum`, `min`, `max`) are real. See [`spec.md`](./spec.md)
> for the full design.

An in-memory reactive database for TypeScript apps where every write goes
through a predefined op and every query can be subscribed to.

- **Tables** have a static schema (any [Standard Schema](https://standardschema.dev),
  such as Zod), a single-field primary key, and named indexes.
- **Queries** read one table through one index, once or as a subscription.
- **Ops** are the only way to write: synchronous transactions, defined up front.
- **Aggregates** are derived, read-only tables maintained incrementally. They
  take the place of joins.
- **Effects** run async tasks, one per row of a query, and write back only by
  calling ops.
- **Introspection** (opt-in) exposes the db's own tables, effects and task runs
  as read-only `sys.*` tables you query like any other.

## Install

```sh
pnpm add millpond
# React bindings use the optional `millpond/react` subpath:
pnpm add react
```

## At a glance

```ts
import { createDb, feature, op, table } from "millpond";
import { z } from "zod";

const messages = table(
  z.object({ id: z.string(), threadId: z.string(), body: z.string() }),
  { key: "id", generate: () => crypto.randomUUID(), indexes: { byThread: ["threadId"] } },
);

const send = op((tx, m: { threadId: string; body: string }) => {
  tx.insert(messages, { ...m, id: crypto.randomUUID() });
});

const chat = feature({ tables: { messages }, ops: { send } });

const db = createDb({ features: { chat } });

db.ops.chat.send({ threadId: "t1", body: "hi" });
db.subscribe(messages.byThread.threadIdEq("t1"), (rows) => render(rows));
```

React:

```tsx
import { DbProvider, useOp, useQuery } from "millpond/react";
```

## Development

Requires Node ≥ 20 and pnpm.

```sh
pnpm install
pnpm build          # bundle ESM + CJS + .d.ts to dist/ (tsdown)
pnpm test           # run all tests (vitest) — RED until the engine lands (see below)
pnpm test:spec      # run only the spec acceptance suite (test/spec)
pnpm test:watch
pnpm typecheck      # tsc --noEmit
pnpm check          # lint + format + organize imports (biome, writes)
pnpm verify         # biome ci + typecheck + test + build
pnpm verify:package # publint + are-the-types-wrong
```

### Demo

`pnpm demo` starts a Vite dev server for `demo/`, a chat app built on the
library (imported straight from `src/`). The left column holds chatrooms; the
right shows each effect's tasks and every registered table's live contents,
read from the `sys.*` introspection tables.

`/game/` on the same server is a small idle fishing game with the same side
panels. Every building runs its own effect task that lands a catch each cycle,
and two chained aggregates (`fleet` → `economy`) keep prices and income up to
date.

### Spec acceptance suite

`test/spec/` is an executable, spec-driven acceptance suite — one file per area
of [`spec.md`](./spec.md), with test names that quote the contract. It targets
the *intended* public API (e.g. `messages.byThread.threadIdEq(...)`), so it is
the north star for implementing the engine.

- It runs **by default** and is **red** until the engine is implemented — each
  test currently fails at fixture construction because the factories throw
  `not implemented yet`. As each area lands, its suite goes green.
- Because it targets the not-yet-built type layer, `test/spec/` is **excluded
  from `pnpm typecheck`**. Re-including it (and making it typecheck) is part of
  the acceptance gate once the query-builder/ops types exist.
- Green today: `pnpm typecheck`, `pnpm build`, `pnpm check`, `pnpm verify:package`,
  and the unit tests in `test/*.test.ts`. Red today: `pnpm test` / `pnpm verify`
  (they include the spec suite, by design).

## Project layout

```
src/
  index.ts       # core public API barrel
  react.tsx      # React bindings (millpond/react)
  table.ts op.ts aggregate.ts effect.ts feature.ts db.ts
  query.ts schema.ts reducers.ts internal.ts
test/            # always-green unit tests (reducers, scaffold contract)
  spec/          # executable spec acceptance suite (one file per spec area)
spec.md          # design spec
```

## Toolchain

- **Build:** [tsdown](https://tsdown.dev) — dual ESM/CJS output with bundled `.d.ts`.
- **Test:** [Vitest](https://vitest.dev).
- **Lint & format:** [Biome](https://biomejs.dev).
- **Schemas:** [Standard Schema](https://standardschema.dev) — Zod, Valibot and
  ArkType all work; none is a hard dependency.

## License

MIT © Jani Mustonen
