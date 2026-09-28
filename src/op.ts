import { notImplemented } from "./internal";
import type { Query } from "./query";
import type { Table } from "./table";

/** The transaction handle passed to an op. Its writes commit together. */
export interface Tx {
  /** Inserts the row and returns its key. Throws if the key exists. */
  insert<Row, Key, Insert>(table: Table<Row, Key, Insert>, row: Insert): Key;
  /** Shallow-merges a patch into a new row. Throws if the key is missing. */
  update<Row, Key>(
    table: Table<Row, Key>,
    key: Key,
    patch: Partial<Row> | ((row: Row) => Partial<Row>),
  ): void;
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
export interface Op<Args = unknown> {
  readonly kind: "op";
  /** Phantom args type; not present at runtime. */
  readonly __args?: Args;
}

export function op<Args = void>(fn: (tx: Tx, args: Args) => void): Op<Args> {
  void fn;
  return notImplemented("op()");
}
