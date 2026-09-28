import { notImplemented } from "./internal";
import type { Query } from "./query";
import type { RowOf, Table } from "./table";

/**
 * A reducer folds a group of child values. When a child's value changes, the
 * engine calls `remove` with the old value, then `add` with the new one. The
 * accumulator is private, so a reducer may mutate it in place — but then it
 * must provide `result` to produce the value compared with `Object.is`.
 */
export interface Reducer<T, Acc = unknown, Out = Acc> {
  init(): Acc;
  add(acc: Acc, value: T): Acc;
  remove(acc: Acc, value: T): Acc;
  result?(acc: Acc): Out;
}

/** Options shared by the scope constructors `each` and `reduce`. */
export interface ScopeOptions<Row> {
  /** Only changes to the listed fields rerun a row's scope. */
  rerunOn?: readonly (keyof Row & string)[];
}

/**
 * The reactive read API handed to a compute (or effect `watch`) function. It
 * reads only the declared inputs — `Allowed` is the union of their row types,
 * so reading anything else is a type error — and builds a tree of scopes that
 * recompute incrementally.
 */
export interface ScopeApi<Allowed = unknown> {
  /** Calls `fn` once per row, each in its own scope, and returns the results. */
  each<Row extends Allowed, R>(
    query: Query<Row, readonly Row[]>,
    fn: (row: Row) => R,
    options?: ScopeOptions<Row>,
  ): R[];
  /** Folds the rows of a query with a reducer. */
  reduce<Row extends Allowed, Acc, Out>(
    query: Query<Row, readonly Row[]>,
    reducer: Reducer<Row, Acc, Out>,
    options?: ScopeOptions<Row>,
  ): Out;
  /** Folds a value mapped from each row with a reducer. */
  reduce<Row extends Allowed, M, Acc, Out>(
    query: Query<Row, readonly Row[]>,
    map: (row: Row) => M,
    reducer: Reducer<M, Acc, Out>,
    options?: ScopeOptions<Row>,
  ): Out;
  /** Reads a query inside the current scope. */
  read<Row extends Allowed, Result>(query: Query<Row, Result>): Result;
}

/** An aggregate is its own read-only table, so it is a `Table` too. */
export type Aggregate<Row = unknown, Key = unknown, Insert = unknown> = Table<Row, Key, Insert>;

export interface AggregateConfig<T extends Table, Inputs extends readonly Table[]> {
  /** The output table this aggregate maintains. */
  table: T;
  /** Every table and aggregate the compute function may read. */
  inputs: Inputs;
  /** Emits rows from a tree of scopes restricted to the declared inputs. */
  compute: (q: ScopeApi<RowOf<Inputs[number]>>, emit: (row: RowOf<T>) => void) => void;
}

export function aggregate<T extends Table, const Inputs extends readonly Table[]>(
  config: AggregateConfig<T, Inputs>,
): T {
  void config;
  return notImplemented("aggregate()");
}
