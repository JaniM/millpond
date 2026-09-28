import {
  INTERNAL,
  PK_INDEX,
  type Primitive,
  type QueryInfo,
  type Range,
  type TableDef,
} from "./internal";
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
export function table(
  schema: StandardSchemaV1,
  options: { key: string; generate?: () => unknown; indexes?: Record<string, readonly string[]> },
): unknown {
  if (typeof schema?.["~standard"]?.validate !== "function") {
    throw new TypeError("reactive-db: table() expects a Standard Schema.");
  }
  if (typeof options?.key !== "string") {
    throw new TypeError("reactive-db: table() expects a `key` option naming the primary key.");
  }
  const indexes = new Map<string, readonly string[]>([[PK_INDEX, [options.key]]]);
  for (const [name, cols] of Object.entries(options.indexes ?? {})) {
    if (name === "all" || name === "get" || name === PK_INDEX) {
      throw new Error(`reactive-db: "${name}" is reserved and cannot name an index.`);
    }
    indexes.set(name, [...cols]);
  }
  const def: TableDef = {
    id: nextTableId++,
    schema,
    key: options.key,
    generate: options.generate,
    indexes,
    aggregate: undefined,
  };

  const surface: Record<string | symbol, unknown> = {
    kind: "table",
    [INTERNAL]: def,
    all: () => makeQuery(def, PK_INDEX, [], undefined, false),
    get: (key: Primitive) => makeQuery(def, PK_INDEX, [key], undefined, true),
  };
  for (const name of indexes.keys()) {
    if (name !== PK_INDEX) surface[name] = makeStep(def, name, []);
  }
  return surface;
}

let nextTableId = 1;

// --- Query builders ----------------------------------------------------------

type Surface = Record<string | symbol, unknown>;

function makeQuery(
  def: TableDef,
  index: string,
  prefix: readonly Primitive[],
  range: Range | undefined,
  single: boolean,
): Surface {
  const cols = def.indexes.get(index) ?? [];
  const info: QueryInfo = {
    table: def,
    index,
    cols,
    prefix,
    range,
    single,
    key: JSON.stringify([
      def.id,
      index,
      single,
      prefix.map(encode),
      range && [
        range.hasLo,
        encode(range.lo),
        range.loInc,
        range.hasHi,
        encode(range.hi),
        range.hiInc,
      ],
    ]),
  };
  return { kind: "query", [INTERNAL]: info };
}

/** Encodes a value so that values of different types never collide. */
function encode(v: Primitive): unknown {
  return v === undefined ? ["u"] : typeof v === "number" ? ["n", String(v)] : v;
}

/** A step before `prefix.length`'s column: `<col>Eq` plus the comparisons. */
function makeStep(def: TableDef, index: string, prefix: readonly Primitive[]): Surface {
  const q = makeQuery(def, index, prefix, undefined, false);
  const cols = def.indexes.get(index) ?? [];
  const col = cols[prefix.length];
  if (col === undefined) return q;
  q[`${col}Eq`] = (v: Primitive) => makeStep(def, index, [...prefix, v]);
  const bound = (r: Partial<Range>) => makeRange(def, index, prefix, col, { ...NO_RANGE, ...r });
  q[`${col}Gt`] = (v: Primitive) => bound({ hasLo: true, lo: v, loInc: false });
  q[`${col}Gte`] = (v: Primitive) => bound({ hasLo: true, lo: v, loInc: true });
  q[`${col}Lt`] = (v: Primitive) => bound({ hasHi: true, hi: v, hiInc: false });
  q[`${col}Lte`] = (v: Primitive) => bound({ hasHi: true, hi: v, hiInc: true });
  return q;
}

const NO_RANGE: Range = { hasLo: false, loInc: false, hasHi: false, hiInc: false };

/** A range query; the complementary bound may still be added once. */
function makeRange(
  def: TableDef,
  index: string,
  prefix: readonly Primitive[],
  col: string,
  range: Range,
): Surface {
  const q = makeQuery(def, index, prefix, range, false);
  if (!range.hasHi) {
    q[`${col}Lt`] = (v: Primitive) =>
      makeRange(def, index, prefix, col, { ...range, hasHi: true, hi: v, hiInc: false });
    q[`${col}Lte`] = (v: Primitive) =>
      makeRange(def, index, prefix, col, { ...range, hasHi: true, hi: v, hiInc: true });
  }
  if (!range.hasLo) {
    q[`${col}Gt`] = (v: Primitive) =>
      makeRange(def, index, prefix, col, { ...range, hasLo: true, lo: v, loInc: false });
    q[`${col}Gte`] = (v: Primitive) =>
      makeRange(def, index, prefix, col, { ...range, hasLo: true, lo: v, loInc: true });
  }
  return q;
}
