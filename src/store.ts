import {
  type AnyRow,
  compareValues,
  inRange,
  matchesQuery,
  type QueryInfo,
  type TableDef,
} from "./internal";

// --- Sorted index ----------------------------------------------------------------

interface Entry {
  /** The index columns followed by the primary key, which makes entries unique. */
  readonly tuple: readonly unknown[];
  readonly row: AnyRow;
}

function compareTuples(a: readonly unknown[], b: readonly unknown[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = compareValues(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/**
 * One index as a sorted array of entries. Prefix and range scans are a binary
 * search plus a walk; writes are a binary search plus a splice.
 */
export class SortedIndex {
  private readonly entries: Entry[] = [];

  constructor(
    readonly cols: readonly string[],
    private readonly keyField: string,
  ) {}

  private tupleOf(row: AnyRow): unknown[] {
    const t = this.cols.map((c) => row[c]);
    t.push(row[this.keyField]);
    return t;
  }

  /** First position whose entry is not `before`. */
  private search(before: (e: Entry) => boolean): number {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (before(this.entries[mid] as Entry)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  insert(row: AnyRow): void {
    const tuple = this.tupleOf(row);
    const i = this.search((e) => compareTuples(e.tuple, tuple) < 0);
    this.entries.splice(i, 0, { tuple, row });
  }

  remove(row: AnyRow): void {
    const tuple = this.tupleOf(row);
    const i = this.search((e) => compareTuples(e.tuple, tuple) < 0);
    const e = this.entries[i];
    if (e !== undefined && compareTuples(e.tuple, tuple) === 0) this.entries.splice(i, 1);
  }

  scan(q: QueryInfo): AnyRow[] {
    const { prefix, range } = q;
    const n = prefix.length;
    const cmpPrefix = (e: Entry) => {
      for (let i = 0; i < n; i++) {
        const c = compareValues(e.tuple[i], prefix[i]);
        if (c !== 0) return c;
      }
      return 0;
    };
    const start = this.search((e) => {
      const c = cmpPrefix(e);
      if (c !== 0) return c < 0;
      if (range?.hasLo) {
        const r = compareValues(e.tuple[n], range.lo);
        return r < 0 || (r === 0 && !range.loInc);
      }
      return false;
    });
    const out: AnyRow[] = [];
    for (let i = start; i < this.entries.length; i++) {
      const e = this.entries[i] as Entry;
      if (cmpPrefix(e) !== 0) break;
      if (range !== undefined && !inRange(range, e.tuple[n])) {
        if (range.hasHi) break; // past the upper bound
        continue;
      }
      out.push(e.row);
    }
    return out;
  }
}

// --- Table state -----------------------------------------------------------------

/** One table's rows in one db. */
export class TableState {
  readonly rows = new Map<unknown, AnyRow>();
  readonly indexes = new Map<string, SortedIndex>();

  constructor(
    readonly def: TableDef,
    readonly name: string,
  ) {
    for (const [name, cols] of def.indexes) this.indexes.set(name, new SortedIndex(cols, def.key));
  }

  set(key: unknown, row: AnyRow): void {
    const old = this.rows.get(key);
    for (const idx of this.indexes.values()) {
      if (old !== undefined) idx.remove(old);
      idx.insert(row);
    }
    this.rows.set(key, row);
  }

  delete(key: unknown): void {
    const old = this.rows.get(key);
    if (old === undefined) return;
    for (const idx of this.indexes.values()) idx.remove(old);
    this.rows.delete(key);
  }

  /** Reads a query against the stored rows (a fresh array, or a row). */
  read(q: QueryInfo): AnyRow[] | AnyRow | undefined {
    if (q.single) return this.rows.get(q.prefix[0]);
    const idx = this.indexes.get(q.index);
    if (idx === undefined) throw new Error(`reactive-db: unknown index "${q.index}".`);
    return idx.scan(q);
  }
}

// --- Watcher registry -------------------------------------------------------------

export interface Watcher {
  readonly query: QueryInfo;
}

interface IndexWatchers<W> {
  readonly cols: readonly string[];
  readonly byPrefix: Map<string, Set<W>>;
  size: number;
}

const prefixKey = (values: readonly unknown[]) =>
  JSON.stringify(values.map((v) => (typeof v === "number" ? ["n", String(v)] : v)));

/**
 * Watchers registered by query prefix: a changed row finds every affected
 * watcher with one hash lookup per prefix length of each watched index.
 */
export class Registry<W extends Watcher> {
  private readonly byTable = new Map<TableDef, Map<string, IndexWatchers<W>>>();

  private bucket(q: QueryInfo): { iw: IndexWatchers<W>; key: string } {
    let indexes = this.byTable.get(q.table);
    if (indexes === undefined) {
      indexes = new Map();
      this.byTable.set(q.table, indexes);
    }
    let iw = indexes.get(q.index);
    if (iw === undefined) {
      iw = { cols: q.cols, byPrefix: new Map(), size: 0 };
      indexes.set(q.index, iw);
    }
    return { iw, key: prefixKey(q.prefix) };
  }

  add(w: W): void {
    const { iw, key } = this.bucket(w.query);
    let set = iw.byPrefix.get(key);
    if (set === undefined) {
      set = new Set();
      iw.byPrefix.set(key, set);
    }
    if (!set.has(w)) {
      set.add(w);
      iw.size++;
    }
  }

  remove(w: W): void {
    const { iw, key } = this.bucket(w.query);
    const set = iw.byPrefix.get(key);
    if (set?.delete(w)) {
      iw.size--;
      if (set.size === 0) iw.byPrefix.delete(key);
    }
  }

  /** Adds to `out` every watcher whose query matches `row`. */
  collect(table: TableDef, row: AnyRow, out: Set<W>): void {
    const indexes = this.byTable.get(table);
    if (indexes === undefined) return;
    for (const iw of indexes.values()) {
      if (iw.size === 0) continue;
      const values = iw.cols.map((c) => row[c]);
      for (let len = 0; len <= values.length; len++) {
        const set = iw.byPrefix.get(prefixKey(values.slice(0, len)));
        if (set === undefined) continue;
        for (const w of set) if (matchesQuery(w.query, row)) out.add(w);
      }
    }
  }
}
