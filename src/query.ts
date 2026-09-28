/**
 * A query reads one table through one index: equality on a prefix of the
 * index columns, then optionally a comparison on the next column. Queries are
 * plain values that do not belong to any db; equal queries are structurally
 * identical and share a subscription and cached result.
 *
 * `Result` is what a read of this query yields — `readonly Row[]` for `all()`
 * and index scans, `Row | undefined` for `get()`.
 */
export interface Query<Row = unknown, Result = readonly Row[]> {
  readonly kind: "query";
  /** Phantom row type; not present at runtime. */
  readonly __row?: Row;
  /** Phantom result type; not present at runtime. */
  readonly __result?: Result;
}

// --- Field-named query builder --------------------------------------------
//
// Given the remaining index columns, each step offers methods named after the
// next column: `<field>Eq` (advances the prefix) plus `<field>Gt/Gte/Lt/Lte`
// (a comparison ends the prefix; the complementary bound may still be added to
// form a range). Every step is itself a readable `Query`.

type EqStep<Row, C extends keyof Row, Next> = {
  [K in C & string as `${K}Eq`]: (value: Row[K]) => Next;
};

/** After a lower bound (`Gt`/`Gte`), the upper bound is still available. */
type UpperOpen<Row, C extends keyof Row, Result> = Query<Row, Result> & {
  [K in C & string as `${K}Lt`]: (value: Row[K]) => Query<Row, Result>;
} & {
  [K in C & string as `${K}Lte`]: (value: Row[K]) => Query<Row, Result>;
};

/** After an upper bound (`Lt`/`Lte`), the lower bound is still available. */
type LowerOpen<Row, C extends keyof Row, Result> = Query<Row, Result> & {
  [K in C & string as `${K}Gt`]: (value: Row[K]) => Query<Row, Result>;
} & {
  [K in C & string as `${K}Gte`]: (value: Row[K]) => Query<Row, Result>;
};

type CmpStep<Row, C extends keyof Row, Result> = {
  [K in C & string as `${K}Gt`]: (value: Row[K]) => UpperOpen<Row, C, Result>;
} & {
  [K in C & string as `${K}Gte`]: (value: Row[K]) => UpperOpen<Row, C, Result>;
} & {
  [K in C & string as `${K}Lt`]: (value: Row[K]) => LowerOpen<Row, C, Result>;
} & {
  [K in C & string as `${K}Lte`]: (value: Row[K]) => LowerOpen<Row, C, Result>;
};

/**
 * A query builder positioned before the given index columns. Consuming a
 * column with `<field>Eq` advances to the next; a comparison ends the prefix.
 */
export type Step<Row, Cols extends readonly (keyof Row)[], Result> = Cols extends readonly [
  infer C extends keyof Row,
  ...infer Rest extends readonly (keyof Row)[],
]
  ? Query<Row, Result> & EqStep<Row, C, Step<Row, Rest, Result>> & CmpStep<Row, C, Result>
  : Query<Row, Result>;
