import type { StandardSchemaV1 } from "./schema";

// Runtime internals shared by the definition factories and the engine. The
// public types stay phantom-typed; the data lives behind these symbols.

/** Hidden slot holding a definition's runtime data. */
export const INTERNAL: unique symbol = Symbol("millpond.internal");

export type Primitive = string | number | boolean | null | undefined;
export type AnyRow = Record<string, unknown>;

/** The name of the built-in primary-key index (also used by `all()`). */
export const PK_INDEX = "$pk";

export interface TableDef {
  readonly id: number;
  readonly schema: StandardSchemaV1;
  readonly key: string;
  readonly generate: (() => unknown) | undefined;
  /** Every index by name, including the primary-key index. */
  readonly indexes: ReadonlyMap<string, readonly string[]>;
  /** Set by `aggregate()` when this table is an aggregate's output. */
  aggregate: AggregateDef | undefined;
}

export interface AggregateDef {
  readonly inputs: readonly object[];
  readonly compute: (q: unknown, emit: (row: AnyRow) => void) => void;
}

export interface EffectDef {
  readonly inputs: readonly object[];
  readonly watch: (
    q: unknown,
    task: (fn: (ctx: unknown) => unknown, options?: { label?: string }) => void,
  ) => void;
}

export interface OpDef {
  readonly fn: (tx: unknown, args: unknown) => unknown;
}

export interface FeatureDef {
  readonly tables: Record<string, object>;
  readonly ops: Record<string, object>;
  readonly effects: Record<string, object>;
}

export interface Range {
  readonly lo?: Primitive;
  readonly loInc: boolean;
  readonly hi?: Primitive;
  readonly hiInc: boolean;
  readonly hasLo: boolean;
  readonly hasHi: boolean;
}

/** A query's structural description. Equal `key`s mean equal queries. */
export interface QueryInfo {
  readonly table: TableDef;
  readonly index: string;
  readonly cols: readonly string[];
  readonly prefix: readonly Primitive[];
  readonly range: Range | undefined;
  /** A `get(key)` query, whose result is one row or `undefined`. */
  readonly single: boolean;
  readonly key: string;
}

export function internalOf<T>(value: unknown, what: string): T {
  const data =
    value !== null && typeof value === "object"
      ? (value as { [INTERNAL]?: T })[INTERNAL]
      : undefined;
  if (data === undefined) throw new TypeError(`millpond: expected a ${what}.`);
  return data;
}

// --- Ordering ------------------------------------------------------------------

function rank(v: unknown): number {
  if (v === null || v === undefined) return 0; // nulls sort first
  switch (typeof v) {
    case "boolean":
      return 1;
    case "number":
      return 2;
    case "string":
      return 3;
    default:
      return 4;
  }
}

/** Total order over indexable values: nulls, booleans, numbers, strings. */
export function compareValues(a: unknown, b: unknown): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0 || a === b) return 0;
  return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
}

/** Whether `row` satisfies the query's prefix equalities and range. */
export function matchesQuery(q: QueryInfo, row: AnyRow): boolean {
  for (let i = 0; i < q.prefix.length; i++) {
    if (compareValues(row[q.cols[i] as string], q.prefix[i]) !== 0) return false;
  }
  return q.range === undefined || inRange(q.range, row[q.cols[q.prefix.length] as string]);
}

export function inRange(r: Range, v: unknown): boolean {
  if (r.hasLo) {
    const c = compareValues(v, r.lo);
    if (c < 0 || (c === 0 && !r.loInc)) return false;
  }
  if (r.hasHi) {
    const c = compareValues(v, r.hi);
    if (c > 0 || (c === 0 && !r.hiInc)) return false;
  }
  return true;
}

// --- Equality ------------------------------------------------------------------

/** Structural equality, used to detect schemas whose output differs from input. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.hasOwn(b, k)) return false;
    if (!deepEqual((a as AnyRow)[k], (b as AnyRow)[k])) return false;
  }
  return true;
}

/** Equal query results: the same value, or arrays of the same rows in order. */
export function sameResult(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Same keys with `Object.is`-equal values. */
export function shallowEqual(a: AnyRow, b: AnyRow): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!Object.hasOwn(b, k) || !Object.is(a[k], b[k])) return false;
  }
  return true;
}

export function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    v !== null &&
    (typeof v === "object" || typeof v === "function") &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

export function isAbortError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}

export function abortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("millpond: the task was aborted.", "AbortError");
  }
  const err = new Error("millpond: the task was aborted.");
  err.name = "AbortError";
  return err;
}
