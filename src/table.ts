import { notImplemented } from "./internal";
import type { Query, Step } from "./query";
import type { InferRow, StandardSchemaV1 } from "./schema";

/** Values allowed in a primary key or index column (nullable primitives). */
export type Indexable = string | number | boolean | null;

/** The columns of `Row` usable as a key or index column. */
export type IndexableKeys<Row> = {
  [K in keyof Row]-?: Row[K] extends Indexable ? K : never;
}[keyof Row] &
  string;

/** A map of index name → the ordered columns that compose it. */
export type IndexMap<Row> = Record<string, readonly IndexableKeys<Row>[]>;

export interface TableOptions<Row, Key extends IndexableKeys<Row> = IndexableKeys<Row>> {
  /** The single-field primary key. Always indexed. */
  key: Key;
  /** Optional key generator; makes the key optional in `insert`. */
  generate?: () => Row[Key];
  /** Named composite indexes, each a list of columns. */
  indexes?: IndexMap<Row>;
}

/** @deprecated Prefer `IndexableKeys`. Kept for the public type re-export. */
export type IndexColumns<Row> = readonly IndexableKeys<Row>[];

/**
 * A table definition: an object schema plus a single-field primary key and
 * named indexes. `Row` is the stored row type, `Key` the key's value type, and
 * `Insert` the row shape `tx.insert` accepts (the full row, or the row with the
 * key optional when a generator is configured). The query surface (`all`,
 * `get`, index accessors) is added by `table()`.
 */
export interface Table<Row = unknown, Key = unknown, Insert = unknown> {
  readonly kind: "table";
  /** Phantom row type; not present at runtime. */
  readonly __row?: Row;
  /** Phantom key-value type; not present at runtime. */
  readonly __key?: Key;
  /** Phantom insert-row type; not present at runtime. */
  readonly __insert?: Insert;
}

/** The row type of a table definition. */
export type RowOf<T extends Table> =
  T extends Table<infer Row, infer _Key, infer _Insert> ? Row : never;

/** The row a generated table accepts on insert: the key becomes optional. */
export type InsertRow<Row, Key extends keyof Row> = Omit<Row, Key> & Partial<Pick<Row, Key>>;

/** The read/query surface attached to a concrete table. */
export type TableQueries<Row, Key, Indexes extends IndexMap<Row>> = {
  /** Every row of the table. */
  all(): Query<Row, readonly Row[]>;
  /** One row by primary key, or `undefined`. */
  get(key: Key): Query<Row, Row | undefined>;
} & {
  [I in keyof Indexes]: Step<Row, Indexes[I], readonly Row[]>;
};

/** The full type of a concrete table: its marker plus its query surface. */
export type TableFor<
  Row,
  Key extends IndexableKeys<Row>,
  Indexes extends IndexMap<Row>,
  Insert = Row,
> = Table<Row, Row[Key], Insert> & TableQueries<Row, Row[Key], Indexes>;

// With a key generator, the key is optional in `insert`.
export function table<
  S extends StandardSchemaV1,
  const Key extends IndexableKeys<InferRow<S>>,
  const Indexes extends IndexMap<InferRow<S>> = Record<never, never>,
>(
  schema: S,
  options: { key: Key; generate: () => InferRow<S>[Key]; indexes?: Indexes },
): TableFor<InferRow<S>, Key, Indexes, InsertRow<InferRow<S>, Key>>;
// Without a generator, `insert` requires the whole row.
export function table<
  S extends StandardSchemaV1,
  const Key extends IndexableKeys<InferRow<S>>,
  const Indexes extends IndexMap<InferRow<S>> = Record<never, never>,
>(schema: S, options: { key: Key; indexes?: Indexes }): TableFor<InferRow<S>, Key, Indexes>;
export function table(schema: unknown, options: unknown): never {
  void schema;
  void options;
  return notImplemented("table()");
}
