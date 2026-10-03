import { StandardSchemaV1 } from "@standard-schema/spec";
//#region src/query.d.ts
/**
 * A query reads one table through one index: equality on a prefix of the
 * index columns, then optionally a comparison on the next column. Queries are
 * plain values that do not belong to any db; equal queries are structurally
 * identical and share a subscription and cached result.
 *
 * `Result` is what a read of this query yields — `readonly Row[]` for `all()`
 * and index scans, `Row | undefined` for `get()`.
 */
interface Query<Row = unknown, Result = readonly Row[]> {
  readonly kind: "query";
  /** Phantom row type; not present at runtime. */
  readonly __row?: Row;
  /** Phantom result type; not present at runtime. */
  readonly __result?: Result;
}
type EqStep<Row, C extends keyof Row, Next> = { [K in C & string as `${K}Eq`]: (value: Row[K]) => Next; };
/** After a lower bound (`Gt`/`Gte`), the upper bound is still available. */
type UpperOpen<Row, C extends keyof Row, Result> = Query<Row, Result> & { [K in C & string as `${K}Lt`]: (value: Row[K]) => Query<Row, Result>; } & { [K in C & string as `${K}Lte`]: (value: Row[K]) => Query<Row, Result>; };
/** After an upper bound (`Lt`/`Lte`), the lower bound is still available. */
type LowerOpen<Row, C extends keyof Row, Result> = Query<Row, Result> & { [K in C & string as `${K}Gt`]: (value: Row[K]) => Query<Row, Result>; } & { [K in C & string as `${K}Gte`]: (value: Row[K]) => Query<Row, Result>; };
type CmpStep<Row, C extends keyof Row, Result> = { [K in C & string as `${K}Gt`]: (value: Row[K]) => UpperOpen<Row, C, Result>; } & { [K in C & string as `${K}Gte`]: (value: Row[K]) => UpperOpen<Row, C, Result>; } & { [K in C & string as `${K}Lt`]: (value: Row[K]) => LowerOpen<Row, C, Result>; } & { [K in C & string as `${K}Lte`]: (value: Row[K]) => LowerOpen<Row, C, Result>; };
/**
 * A query builder positioned before the given index columns. Consuming a
 * column with `<field>Eq` advances to the next; a comparison ends the prefix.
 */
type Step<Row, Cols extends readonly (keyof Row)[], Result> = Cols extends readonly [infer C extends keyof Row, ...infer Rest extends readonly (keyof Row)[]] ? Query<Row, Result> & EqStep<Row, C, Step<Row, Rest, Result>> & CmpStep<Row, C, Result> : Query<Row, Result>;
//#endregion
//#region src/schema.d.ts
/** Any Standard Schema — Zod, Valibot and ArkType all implement it. */
type Schema = StandardSchemaV1;
/** The row type stored for a table: the schema's output type. */
type InferRow<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>;
//#endregion
//#region src/table.d.ts
/** Values allowed in a primary key or index column (nullable primitives). */
type Indexable = string | number | boolean | null;
/** The columns of `Row` usable as a key or index column. */
type IndexableKeys<Row> = { [K in keyof Row]-?: Row[K] extends Indexable ? K : never; }[keyof Row] & string;
/** A map of index name → the ordered columns that compose it. */
type IndexMap<Row> = Record<string, readonly IndexableKeys<Row>[]>;
interface TableOptions<Row, Key extends IndexableKeys<Row> = IndexableKeys<Row>> {
  /** The single-field primary key. Always indexed. */
  key: Key;
  /** Optional key generator; makes the key optional in `insert`. */
  generate?: () => Row[Key];
  /** Named composite indexes, each a list of columns. */
  indexes?: IndexMap<Row>;
}
/** @deprecated Prefer `IndexableKeys`. Kept for the public type re-export. */
type IndexColumns<Row> = readonly IndexableKeys<Row>[];
/**
 * A table definition: an object schema plus a single-field primary key and
 * named indexes. `Row` is the stored row type, `Key` the key's value type, and
 * `Insert` the row shape `tx.insert` accepts (the full row, or the row with the
 * key optional when a generator is configured). The query surface (`all`,
 * `get`, index accessors) is added by `table()`.
 */
interface Table<Row = unknown, Key = unknown, Insert = unknown> {
  readonly kind: "table";
  /** Phantom row type; not present at runtime. */
  readonly __row?: Row;
  /** Phantom key-value type; not present at runtime. */
  readonly __key?: Key;
  /** Phantom insert-row type; not present at runtime. */
  readonly __insert?: Insert;
}
/** The row type of a table definition. */
type RowOf<T extends Table> = T extends Table<infer Row, infer _Key, infer _Insert> ? Row : never;
/** The row a generated table accepts on insert: the key becomes optional. */
type InsertRow<Row, Key extends keyof Row> = Omit<Row, Key> & Partial<Pick<Row, Key>>;
/** The read/query surface attached to a concrete table. */
type TableQueries<Row, Key, Indexes extends IndexMap<Row>> = {
  /** Every row of the table. */
  all(): Query<Row, readonly Row[]>;
  /** One row by primary key, or `undefined`. */
  get(key: Key): Query<Row, Row | undefined>;
} & { [I in keyof Indexes]: Step<Row, Indexes[I], readonly Row[]>; };
/** The full type of a concrete table: its marker plus its query surface. */
type TableFor<Row, Key extends IndexableKeys<Row>, Indexes extends IndexMap<Row>, Insert = Row> = Table<Row, Row[Key], Insert> & TableQueries<Row, Row[Key], Indexes>;
declare function table<S extends StandardSchemaV1, const Key extends IndexableKeys<InferRow<S>>, const Indexes extends IndexMap<InferRow<S>> = Record<never, never>>(schema: S, options: {
  key: Key;
  generate: () => InferRow<S>[Key];
  indexes?: Indexes;
}): TableFor<InferRow<S>, Key, Indexes, InsertRow<InferRow<S>, Key>>;
declare function table<S extends StandardSchemaV1, const Key extends IndexableKeys<InferRow<S>>, const Indexes extends IndexMap<InferRow<S>> = Record<never, never>>(schema: S, options: {
  key: Key;
  indexes?: Indexes;
}): TableFor<InferRow<S>, Key, Indexes>;
//#endregion
//#region src/aggregate.d.ts
/**
 * A reducer folds a group of child values. When a child's value changes, the
 * engine calls `remove` with the old value, then `add` with the new one. The
 * accumulator is private, so a reducer may mutate it in place — but then it
 * must provide `result` to produce the value compared with `Object.is`.
 */
interface Reducer<T, Acc = unknown, Out = Acc> {
  init(): Acc;
  add(acc: Acc, value: T): Acc;
  remove(acc: Acc, value: T): Acc;
  result?(acc: Acc): Out;
}
/** Options shared by the scope constructors `each` and `reduce`. */
interface ScopeOptions<Row> {
  /** Only changes to the listed fields rerun a row's scope. */
  rerunOn?: readonly (keyof Row & string)[];
}
/**
 * The reactive read API handed to a compute (or effect `watch`) function. It
 * reads only the declared inputs — `Allowed` is the union of their row types,
 * so reading anything else is a type error — and builds a tree of scopes that
 * recompute incrementally.
 */
interface ScopeApi<Allowed = unknown> {
  /** Calls `fn` once per row, each in its own scope, and returns the results. */
  each<Row extends Allowed, R>(query: Query<Row, readonly Row[]>, fn: (row: Row) => R, options?: ScopeOptions<Row>): R[];
  /** Folds the rows of a query with a reducer. */
  reduce<Row extends Allowed, Acc, Out>(query: Query<Row, readonly Row[]>, reducer: Reducer<Row, Acc, Out>, options?: ScopeOptions<Row>): Out;
  /** Folds a value mapped from each row with a reducer. */
  reduce<Row extends Allowed, M, Acc, Out>(query: Query<Row, readonly Row[]>, map: (row: Row) => M, reducer: Reducer<M, Acc, Out>, options?: ScopeOptions<Row>): Out;
  /** Reads a query inside the current scope. */
  read<Row extends Allowed, Result>(query: Query<Row, Result>): Result;
}
/** An aggregate is its own read-only table, so it is a `Table` too. */
type Aggregate<Row = unknown, Key = unknown, Insert = unknown> = Table<Row, Key, Insert>;
interface AggregateConfig<T extends Table, Inputs extends readonly Table[]> {
  /** The output table this aggregate maintains. */
  table: T;
  /** Every table and aggregate the compute function may read. */
  inputs: Inputs;
  /** Emits rows from a tree of scopes restricted to the declared inputs. */
  compute: (q: ScopeApi<RowOf<Inputs[number]>>, emit: (row: RowOf<T>) => void) => void;
}
declare function aggregate<T extends Table, const Inputs extends readonly Table[]>(config: AggregateConfig<T, Inputs>): T;
//#endregion
//#region src/op.d.ts
/** The transaction handle passed to an op. Its writes commit together. */
interface Tx {
  /** Inserts the row and returns its key. Throws if the key exists. */
  insert<Row, Key, Insert>(table: Table<Row, Key, Insert>, row: Insert): Key;
  /** Shallow-merges a patch into a new row. Throws if the key is missing. */
  update<Row, Key>(table: Table<Row, Key>, key: Key, patch: Partial<Row> | ((row: Row) => Partial<Row>)): void;
  /** Inserts or replaces, and returns the key. */
  upsert<Row, Key>(table: Table<Row, Key>, row: Row): Key;
  /** Deletes the row. Throws if the key is missing. */
  delete<Row, Key>(table: Table<Row, Key>, key: Key): void;
  /** Reads a query, including the op's own writes. */
  read<Row, Result>(query: Query<Row, Result>): Result;
  /** Runs another op inline as a savepoint. */
  run<Args>(op: Op<Args>, args: Args): void;
}
/**
 * An op is a synchronous function of a transaction and its arguments. It
 * commits all of its writes, or, if it throws, none of them.
 *
 * `Args` defaults to `unknown` so that bare `Op` is the supertype of every
 * op (used in `Record<string, Op>` constraints); the covariant phantom keeps
 * `Op<Specific>` assignable to it. `op()` below defaults an argument-free op to
 * `Op<void>`.
 */
interface Op<Args = unknown> {
  readonly kind: "op";
  /** Phantom args type; not present at runtime. */
  readonly __args?: Args;
}
declare function op<Args = void>(fn: (tx: Tx, args: Args) => void): Op<Args>;
//#endregion
//#region src/effect.d.ts
/** The context a task runs in. It writes back only through `run`. */
interface TaskContext {
  /** A read-only view of the latest committed state. */
  db: ReadonlyDb;
  /** The only way to write from a task. */
  run<Args>(op: Op<Args>, args: Args, options?: {
    ignoreAbort?: boolean;
  }): void;
  /** Fires when the task is aborted. */
  signal: AbortSignal;
  /**
   * Sets a debugging note on the task's `sys.tasks` row. A no-op without
   * `createDb({ introspect })`, and after the task has finished.
   */
  note(detail: string | null): void;
}
interface TaskOptions {
  /** A human-readable name for introspection; defaults to the scope's path. */
  label?: string;
}
/**
 * Registers the async task for the current scope. Called inside a `watch`
 * scope (`q.each`/`q.reduce`), so `rerunOn` and abort/restart are governed by
 * that scope, not by `task` itself.
 */
type Task = (fn: (ctx: TaskContext) => void | Promise<void>, options?: TaskOptions) => void;
interface EffectConfig<Inputs extends readonly Table[]> {
  /** Every table and aggregate `watch` may read. */
  inputs: Inputs;
  /** Builds scopes restricted to the declared inputs; one task per scope. */
  watch: (q: ScopeApi<RowOf<Inputs[number]>>, task: Task) => void;
}
/** An effect runs one async task per scope, usually one per row of a query. */
interface Effect {
  readonly kind: "effect";
}
declare function effect<const Inputs extends readonly Table[]>(config: EffectConfig<Inputs>): Effect;
//#endregion
//#region src/feature.d.ts
/**
 * A feature groups definitions under named keys. A definition's registered
 * name is the feature key plus its key here (e.g. `chat.send`).
 */
interface Feature<Tables extends Record<string, Table> = Record<string, Table>, Ops extends Record<string, Op> = Record<string, Op>, Effects extends Record<string, Effect> = Record<string, Effect>> {
  readonly kind: "feature";
  /** Phantom maps of the registered definitions; not present at runtime. */
  readonly __tables?: Tables;
  readonly __ops?: Ops;
  readonly __effects?: Effects;
}
interface FeatureConfig<Tables extends Record<string, Table>, Ops extends Record<string, Op>, Effects extends Record<string, Effect>> {
  tables?: Tables;
  ops?: Ops;
  effects?: Effects;
}
declare function feature<Tables extends Record<string, Table> = Record<string, Table>, Ops extends Record<string, Op> = Record<string, Op>, Effects extends Record<string, Effect> = Record<string, Effect>>(config: FeatureConfig<Tables, Ops, Effects>): Feature<Tables, Ops, Effects>;
//#endregion
//#region src/db.d.ts
/** A read-only view of the db, as seen from tasks and outside code. */
interface ReadonlyDb {
  /** One-shot read of a query against the latest committed state. */
  read<Row, Result>(query: Query<Row, Result>): Result;
}
/** Unsubscribe handle returned by `subscribe`. */
type Unsubscribe = () => void;
/**
 * A db handle without the compile-time `ops` tree. Every `Db<Features>` is
 * assignable to it, so it is the type to use where the feature set is not
 * known statically — a provider, a context, or a shared reference. (A concrete
 * `Db<Features>` is not assignable to another `Db` with different features,
 * because op argument types are contravariant.)
 */
interface AnyDb {
  read<Row, Result>(query: Query<Row, Result>): Result;
  subscribe<Row, Result>(query: Query<Row, Result>, listener: (result: Result) => void): Unsubscribe;
  run<Args>(op: Op<Args>, args: Args): void;
  dispose(): void;
}
/** A bound op call: `(args) => void`, or `() => void` for an `Op<void>`. */
type OpFn<Args> = [Args] extends [void] ? () => void : (args: Args) => void;
/** The `db.ops.<feature>.<op>(args)` convenience tree, typed from the features. */
type OpsTree<Features extends Record<string, Feature>> = { [F in keyof Features]: Features[F] extends Feature<infer _Tables, infer Ops, infer _Effects> ? { [K in keyof Ops]: Ops[K] extends Op<infer Args> ? OpFn<Args> : never; } : never; };
/** Passed to `onError`; `source` is the registered name of what failed. */
interface ErrorInfo<Features extends Record<string, Feature> = Record<string, Feature>> {
  db: Db<Features>;
  source: string;
}
interface CreateDbOptions<Features extends Record<string, Feature>> {
  features: Features;
  /** Validate every write against its schema. On by default. */
  validate?: boolean;
  /** Shallow-freeze every stored row. On by default. */
  freeze?: boolean;
  /**
   * Maintain the `sys.*` system tables. Off by default. `history` is how many
   * finished task runs to keep per effect (20 by default).
   */
  introspect?: boolean | {
    history?: number;
  };
  /** Runs after the flush; may call ops, e.g. to record the error. */
  onError?: (err: unknown, info: ErrorInfo<Features>) => void;
}
interface Db<Features extends Record<string, Feature> = Record<string, Feature>> extends AnyDb {
  /** The `db.ops.<feature>.<op>()` convenience tree. */
  ops: OpsTree<Features>;
}
declare function createDb<const Features extends Record<string, Feature>>(options: CreateDbOptions<Features>): Db<Features>;
//#endregion
export { Indexable as A, Schema as B, AggregateConfig as C, aggregate as D, ScopeOptions as E, TableFor as F, Query as H, TableOptions as I, TableQueries as L, InsertRow as M, RowOf as N, IndexColumns as O, Table as P, table as R, Aggregate as S, ScopeApi as T, Step as U, StandardSchemaV1 as V, TaskOptions as _, OpFn as a, Tx as b, Unsubscribe as c, FeatureConfig as d, feature as f, TaskContext as g, Task as h, ErrorInfo as i, IndexableKeys as j, IndexMap as k, createDb as l, EffectConfig as m, CreateDbOptions as n, OpsTree as o, Effect as p, Db as r, ReadonlyDb as s, AnyDb as t, Feature as u, effect as v, Reducer as w, op as x, Op as y, InferRow as z };
//# sourceMappingURL=db-DJXBIulF.d.cts.map