import type { Reducer } from "./aggregate";
import { type AnyRow, internalOf, matchesQuery, type QueryInfo, type TableDef } from "./internal";
import { Registry } from "./store";
import type { AbortReason } from "./sys";

// The scope tree behind aggregates and effects. A scope runs a function,
// records what it read, and owns the collections (`q.each`/`q.reduce`) it
// created. Changes arrive as row diffs in an inbox; they mark the affected
// scopes and collections dirty, and `update()` then walks only the dirty paths.

/** What a scope engine needs from its db. */
export interface ScopeHost {
  /** The committed rows of a query, as a fresh array (a `get` gives 0 or 1). */
  rows(q: QueryInfo): AnyRow[];
  /** A committed read of a query (the same value `db.read` gives). */
  readQuery(q: QueryInfo): unknown;
  /** Keeps a query's result cached, so it keeps its identity across reruns. */
  retain(q: QueryInfo): void;
  /** Undoes one `retain`. */
  release(q: QueryInfo): void;
  /** Runs `fn` where ops may not be called. */
  guard<T>(fn: () => T): T;
  report(err: unknown, source: string): void;
}

interface ReadWatch {
  readonly kind: "read";
  readonly query: QueryInfo;
  readonly scope: Scope;
}

interface CollectionWatch {
  readonly kind: "collection";
  readonly query: QueryInfo;
  readonly coll: Collection;
}

type Watch = ReadWatch | CollectionWatch;

type AnyReducer = Reducer<unknown, unknown, unknown>;

export class Scope {
  collections: Collection[] = [];
  reads = new Map<string, ReadWatch>();
  emitted = new Map<unknown, AnyRow>();
  value: unknown = undefined;
  dirtyFull = false;
  dirtyPath = false;
  disposed = false;

  // Per-run state.
  full = false;
  cursor = 0;
  claimed = new Set<Collection>();
  nextCollections: Collection[] = [];
  nextReads = new Map<string, ReadWatch>();

  // Effect state: the task registered in the current run, and the live one.
  nextTask: { fn: (ctx: unknown) => unknown; label: string | undefined } | undefined;
  task: TaskHandle | undefined;

  constructor(
    readonly parent: Collection | undefined,
    readonly key: unknown,
    public row: AnyRow | undefined,
  ) {}
}

export class Collection {
  readonly children = new Map<unknown, Scope>();
  pending = new Map<unknown, AnyRow | undefined>();
  dirtyChildren = new Set<Scope>();
  dirtyPath = false;
  disposed = false;
  acc: unknown;
  result: unknown;
  readonly watch: CollectionWatch;

  constructor(
    readonly owner: Scope,
    readonly kind: "each" | "reduce",
    readonly query: QueryInfo,
    public fn: ((row: AnyRow) => unknown) | undefined,
    readonly reducer: AnyReducer | undefined,
    public rerunOn: readonly string[] | undefined,
  ) {
    this.watch = { kind: "collection", query, coll: this };
  }

  /** The value folded for one child: its scope's return value. */
  resultOf(): unknown {
    const r = this.reducer as AnyReducer;
    return r.result ? r.result(this.acc) : this.acc;
  }
}

export interface TaskHandle {
  readonly fn: (ctx: unknown) => unknown;
  readonly scope: Scope;
  readonly label: string | undefined;
  /** The run this one replaced, for introspection: its id, or its own `restartOf`. */
  readonly restartOf: number | null;
  /** Set when the task starts under introspection. */
  id: number | undefined;
  controller: AbortController | undefined;
  cancelled: boolean;
  /** Called once, when a started task is aborted. */
  onAbort: ((reason: AbortReason) => void) | undefined;
}

export abstract class ScopeEngine {
  readonly registry = new Registry<Watch>();
  readonly inbox = new Map<TableDef, Map<unknown, { before?: AnyRow; after?: AnyRow }>>();
  root: Scope | undefined;
  rootFailed = false;
  busy = false;
  private current: Scope | undefined;
  readonly q: unknown;

  constructor(
    readonly host: ScopeHost,
    readonly name: string,
    readonly inputs: ReadonlySet<TableDef>,
  ) {
    this.q = {
      each: (query: unknown, fn: (row: AnyRow) => unknown, options?: { rerunOn?: string[] }) =>
        this.collection("each", query, fn, undefined, options),
      reduce: (query: unknown, a: unknown, b?: unknown, c?: unknown) =>
        typeof a === "function"
          ? this.collection(
              "reduce",
              query,
              a as (row: AnyRow) => unknown,
              b as AnyReducer,
              c as { rerunOn?: string[] },
            )
          : this.collection(
              "reduce",
              query,
              undefined,
              a as AnyReducer,
              b as { rerunOn?: string[] },
            ),
      read: (query: unknown) => this.read(query),
    };
  }

  /** Runs the root function (compute or watch). */
  protected abstract runRoot(): void;

  // --- Hooks for the concrete engines ---
  protected beforeRun(_scope: Scope): void {}
  protected afterSuccess(_scope: Scope): void {}
  protected afterFailure(_scope: Scope, _prevEmitted: Map<unknown, AnyRow>): void {}
  protected onDispose(_scope: Scope): void {}
  protected afterUpdate(): void {}

  /** Records a committed change to one of this engine's inputs. */
  record(table: TableDef, key: unknown, before: AnyRow | undefined, after: AnyRow | undefined) {
    let changes = this.inbox.get(table);
    if (changes === undefined) {
      changes = new Map();
      this.inbox.set(table, changes);
    }
    const prev = changes.get(key);
    if (prev === undefined) changes.set(key, { before, after });
    else if (prev.before === undefined && after === undefined) changes.delete(key);
    else prev.after = after;
  }

  get stale(): boolean {
    return this.root === undefined || this.inbox.size > 0;
  }

  /** Brings the scope tree up to date with the inbox. */
  update(): void {
    if (this.busy || !this.stale) return;
    this.busy = true;
    try {
      if (this.root === undefined) {
        this.inbox.clear();
        this.root = new Scope(undefined, undefined, undefined);
        this.runScope(this.root, true);
      } else {
        this.applyInbox();
        if (this.rootFailed) this.markFull(this.root);
        if (this.root.dirtyPath || this.root.dirtyFull) this.updateScope(this.root);
      }
      this.afterUpdate();
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    if (this.root !== undefined) this.disposeScope(this.root);
    this.inbox.clear();
  }

  /** The registered name plus the key path of a scope. */
  pathOf(scope: Scope): string {
    const keys: string[] = [];
    for (let s: Scope | undefined = scope; s?.parent !== undefined; s = s.parent.owner) {
      keys.unshift(String(s.key));
    }
    return [this.name, ...keys].join("/");
  }

  protected requireCurrent(what: string): Scope {
    if (this.current === undefined) {
      throw new Error(`reactive-db: ${what} can only be called while ${this.name} is running.`);
    }
    return this.current;
  }

  // --- Marking --------------------------------------------------------------------

  private applyInbox(): void {
    const hit = new Set<Watch>();
    for (const [table, changes] of this.inbox) {
      for (const [key, { before, after }] of changes) {
        hit.clear();
        if (before !== undefined) this.registry.collect(table, before, hit);
        if (after !== undefined) this.registry.collect(table, after, hit);
        for (const w of hit) {
          if (w.kind === "read") {
            if (!w.scope.disposed) this.markFull(w.scope);
          } else if (!w.coll.disposed) {
            const inAfter = after !== undefined && matchesQuery(w.query, after);
            w.coll.pending.set(key, inAfter ? after : undefined);
            this.markCollection(w.coll);
          }
        }
      }
    }
    this.inbox.clear();
  }

  private markFull(scope: Scope): void {
    scope.dirtyFull = true;
    this.markPath(scope);
  }

  private markPath(scope: Scope): void {
    if (scope.dirtyPath) return;
    scope.dirtyPath = true;
    if (scope.parent !== undefined) {
      scope.parent.dirtyChildren.add(scope);
      this.markCollection(scope.parent);
    }
  }

  private markCollection(coll: Collection): void {
    if (coll.dirtyPath) return;
    coll.dirtyPath = true;
    this.markPath(coll.owner);
  }

  // --- Updating -------------------------------------------------------------------

  /** Updates a dirty scope. Returns whether its value changed. */
  private updateScope(scope: Scope): boolean {
    if (scope.disposed) return false;
    if (scope.dirtyFull) return this.runScope(scope, true);
    scope.dirtyPath = false;
    let changed = false;
    for (const coll of scope.collections) {
      if (coll.dirtyPath && this.updateCollection(coll)) changed = true;
    }
    return changed ? this.runScope(scope, false) : false;
  }

  /** Applies a collection's pending row diffs and dirty children. */
  private updateCollection(coll: Collection): boolean {
    coll.dirtyPath = false;
    const pending = coll.pending;
    coll.pending = new Map();
    let changed = false;

    // Removals first, so keys they emitted are free for new scopes.
    for (const [key, after] of pending) {
      if (after !== undefined) continue;
      const child = coll.children.get(key);
      if (child === undefined) continue;
      this.fold(coll, child.value, undefined, true, false);
      this.disposeScope(child);
      coll.children.delete(key);
      changed = true;
    }
    for (const [key, after] of pending) {
      if (after === undefined) continue;
      let child = coll.children.get(key);
      if (child === undefined) {
        child = new Scope(coll, key, after);
        coll.children.set(key, child);
        this.runScope(child, true);
        this.fold(coll, undefined, child.value, false, true);
        changed = true;
        continue;
      }
      const snapshot = child.row as AnyRow;
      if (coll.rerunOn?.every((f) => Object.is(snapshot[f], after[f]))) continue;
      const old = child.value;
      child.row = after;
      if (this.runScope(child, true)) {
        this.fold(coll, old, child.value, true, true);
        changed = true;
      }
    }

    const dirty = coll.dirtyChildren;
    coll.dirtyChildren = new Set();
    for (const child of dirty) {
      if (child.disposed || !(child.dirtyPath || child.dirtyFull)) continue;
      const old = child.value;
      if (this.updateScope(child)) {
        this.fold(coll, old, child.value, true, true);
        changed = true;
      }
    }

    if (!changed) return false;
    if (coll.kind === "each") {
      coll.result = this.eachResult(coll, this.host.rows(coll.query));
      return true;
    }
    const next = coll.resultOf();
    const same = Object.is(next, coll.result);
    coll.result = next;
    return !same;
  }

  /** Folds a child's value change into a reduce accumulator. */
  private fold(coll: Collection, old: unknown, next: unknown, hadOld: boolean, hasNext: boolean) {
    const r = coll.reducer;
    if (r === undefined) return;
    if (hadOld && hasNext && Object.is(old, next)) return;
    if (hadOld) coll.acc = r.remove(coll.acc, old);
    if (hasNext) coll.acc = r.add(coll.acc, next);
  }

  private eachResult(coll: Collection, rows: readonly AnyRow[]): unknown[] {
    const key = coll.query.table.key;
    return rows.map((row) => coll.children.get(row[key])?.value);
  }

  /** Rebuilds a collection against the current rows, rerunning every child. */
  private resync(coll: Collection): void {
    coll.pending.clear();
    coll.dirtyChildren.clear();
    coll.dirtyPath = false;
    const rows = this.host.rows(coll.query);
    const keyField = coll.query.table.key;
    const live = new Set(rows.map((r) => r[keyField]));
    for (const [key, child] of coll.children) {
      if (live.has(key)) continue;
      this.disposeScope(child);
      coll.children.delete(key);
    }
    for (const row of rows) {
      const key = row[keyField];
      let child = coll.children.get(key);
      if (child === undefined) {
        child = new Scope(coll, key, row);
        coll.children.set(key, child);
      } else {
        child.row = row;
      }
      this.runScope(child, true);
    }
    if (coll.kind === "each") {
      coll.result = this.eachResult(coll, rows);
    } else {
      const r = coll.reducer as AnyReducer;
      coll.acc = r.init();
      for (const row of rows) coll.acc = r.add(coll.acc, coll.children.get(row[keyField])?.value);
      coll.result = coll.resultOf();
    }
  }

  // --- Running --------------------------------------------------------------------

  /**
   * Runs a scope's function. A full run reruns every child (they may have
   * captured changed values); otherwise collections return cached results.
   * Returns whether the scope's value changed.
   */
  protected runScope(scope: Scope, full: boolean): boolean {
    scope.dirtyFull = false;
    scope.dirtyPath = false;
    const prevEmitted = scope.emitted;
    const prevCollections = scope.collections;
    const prevReads = scope.reads;
    const prevValue = scope.value;

    this.beforeRun(scope);
    scope.emitted = new Map();
    scope.full = full;
    scope.cursor = 0;
    scope.claimed = new Set();
    scope.nextCollections = [];
    scope.nextReads = new Map();
    scope.nextTask = undefined;

    const saved = this.current;
    this.current = scope;
    let ok = true;
    let value: unknown;
    let error: unknown;
    try {
      value = this.host.guard(() => this.invoke(scope));
    } catch (e) {
      ok = false;
      error = e;
    } finally {
      this.current = saved;
    }

    if (ok) {
      for (const c of prevCollections) if (!scope.claimed.has(c)) this.disposeCollection(c);
      scope.collections = scope.nextCollections;
      for (const [k, w] of prevReads) if (!scope.nextReads.has(k)) this.removeRead(w);
      scope.reads = scope.nextReads;
      scope.value = value;
      if (scope === this.root) this.rootFailed = false;
      this.afterSuccess(scope);
    } else {
      const kept = new Set(prevCollections);
      for (const c of scope.nextCollections) if (!kept.has(c)) this.disposeCollection(c);
      scope.collections = prevCollections;
      // Keep watching what the failed run read too, so it retries on change.
      for (const [k, w] of scope.nextReads) if (!prevReads.has(k)) prevReads.set(k, w);
      scope.reads = prevReads;
      if (scope === this.root) this.rootFailed = true;
      this.afterFailure(scope, prevEmitted);
      this.host.report(error, this.pathOf(scope));
    }
    scope.claimed = new Set();
    scope.nextCollections = [];
    scope.nextReads = new Map();
    return ok && !Object.is(prevValue, value);
  }

  private invoke(scope: Scope): unknown {
    const coll = scope.parent;
    if (coll === undefined) {
      this.runRoot();
      return undefined;
    }
    return coll.fn ? coll.fn(scope.row as AnyRow) : scope.row;
  }

  private checkInput(query: unknown, what: string): QueryInfo {
    const q = internalOf<QueryInfo>(query, "query");
    if (!this.inputs.has(q.table)) {
      throw new Error(
        `reactive-db: ${this.name} called ${what} on a table that is not one of its declared inputs.`,
      );
    }
    return q;
  }

  private collection(
    kind: "each" | "reduce",
    query: unknown,
    fn: ((row: AnyRow) => unknown) | undefined,
    reducer: AnyReducer | undefined,
    options: { rerunOn?: readonly string[] } | undefined,
  ): unknown {
    const scope = this.requireCurrent(`q.${kind}`);
    const q = this.checkInput(query, `q.${kind}`);
    if (kind === "each" && typeof fn !== "function") {
      throw new TypeError("reactive-db: q.each expects a function.");
    }
    if (kind === "reduce" && typeof reducer?.init !== "function") {
      throw new TypeError("reactive-db: q.reduce expects a reducer ({ init, add, remove }).");
    }
    const old = scope.collections[scope.cursor++];
    let coll: Collection;
    if (
      old !== undefined &&
      !scope.claimed.has(old) &&
      old.kind === kind &&
      old.query.key === q.key &&
      old.reducer === reducer &&
      (old.fn === undefined) === (fn === undefined)
    ) {
      coll = old;
      coll.fn = fn;
      coll.rerunOn = options?.rerunOn;
      scope.claimed.add(coll);
      if (scope.full) this.resync(coll);
    } else {
      coll = new Collection(scope, kind, q, fn, reducer, options?.rerunOn);
      this.registry.add(coll.watch);
      this.resync(coll);
    }
    scope.nextCollections.push(coll);
    return coll.result;
  }

  private read(query: unknown): unknown {
    const scope = this.requireCurrent("q.read");
    const q = this.checkInput(query, "q.read");
    if (!scope.nextReads.has(q.key)) {
      let w = scope.reads.get(q.key);
      if (w === undefined) {
        w = { kind: "read", query: q, scope };
        this.registry.add(w);
        this.host.retain(q);
      }
      scope.nextReads.set(q.key, w);
    }
    return this.host.readQuery(q);
  }

  // --- Disposal -------------------------------------------------------------------

  protected disposeScope(scope: Scope): void {
    if (scope.disposed) return;
    scope.disposed = true;
    for (const c of scope.collections) this.disposeCollection(c);
    for (const w of scope.reads.values()) this.removeRead(w);
    this.onDispose(scope);
  }

  private removeRead(w: ReadWatch): void {
    this.registry.remove(w);
    this.host.release(w.query);
  }

  private disposeCollection(coll: Collection): void {
    if (coll.disposed) return;
    coll.disposed = true;
    this.registry.remove(coll.watch);
    for (const child of coll.children.values()) this.disposeScope(child);
    coll.children.clear();
  }
}

// --- Aggregates -------------------------------------------------------------------

export interface OutputSink {
  /** Validates and freezes an emitted row; throws on failure. */
  prepare(row: AnyRow): AnyRow;
  /** Writes (or, with `undefined`, removes) one output row if it differs. */
  write(key: unknown, row: AnyRow | undefined): void;
}

export class AggregateEngine extends ScopeEngine {
  /** Which scope currently owns each output key. */
  private readonly owners = new Map<unknown, Scope>();
  private touched = new Set<unknown>();
  readonly upstream: AggregateEngine[] = [];
  private readonly emit: (row: AnyRow) => void;

  constructor(
    host: ScopeHost,
    name: string,
    inputs: ReadonlySet<TableDef>,
    readonly table: TableDef,
    private readonly compute: (q: unknown, emit: (row: AnyRow) => void) => void,
    private readonly sink: OutputSink,
  ) {
    super(host, name, inputs);
    this.emit = (row) => this.emitRow(row);
  }

  protected runRoot(): void {
    this.compute(this.q, this.emit);
  }

  private emitRow(input: AnyRow): void {
    const scope = this.requireCurrent("emit");
    const row = this.sink.prepare(input);
    const key = row[this.table.key];
    const owner = this.owners.get(key);
    if (owner !== undefined && owner !== scope && !owner.disposed) {
      throw new Error(
        `reactive-db: ${this.name}: two scopes emitted the key ${JSON.stringify(key)} (${this.pathOf(owner)} and ${this.pathOf(scope)}).`,
      );
    }
    this.owners.set(key, scope);
    scope.emitted.set(key, row);
    this.touched.add(key);
  }

  private release(scope: Scope, keys: Iterable<unknown>): void {
    for (const k of keys) {
      if (this.owners.get(k) === scope) this.owners.delete(k);
      this.touched.add(k);
    }
  }

  protected override beforeRun(scope: Scope): void {
    this.release(scope, scope.emitted.keys());
  }

  protected override afterFailure(scope: Scope, prevEmitted: Map<unknown, AnyRow>): void {
    this.release(scope, scope.emitted.keys());
    scope.emitted = prevEmitted;
    for (const k of prevEmitted.keys()) {
      const owner = this.owners.get(k);
      if (owner === undefined || owner.disposed) this.owners.set(k, scope);
      this.touched.add(k);
    }
  }

  protected override onDispose(scope: Scope): void {
    this.release(scope, scope.emitted.keys());
  }

  protected override afterUpdate(): void {
    const touched = this.touched;
    this.touched = new Set();
    for (const key of touched) {
      const owner = this.owners.get(key);
      this.sink.write(key, owner?.emitted.get(key));
    }
  }
}

// --- Effects ----------------------------------------------------------------------

export class EffectEngine extends ScopeEngine {
  disabled = false;
  /** Consecutive chained flushes in which this effect started tasks. */
  streak = 0;
  starts: TaskHandle[] = [];
  /** Why disposing a scope aborts its task; the db sets it when disabling the effect. */
  disposeReason: AbortReason = "scopeDisposed";
  private readonly task: (fn: (ctx: unknown) => unknown, options?: { label?: string }) => void;

  constructor(
    host: ScopeHost,
    name: string,
    inputs: ReadonlySet<TableDef>,
    private readonly watch: (
      q: unknown,
      task: (fn: (ctx: unknown) => unknown, options?: { label?: string }) => void,
    ) => void,
  ) {
    super(host, name, inputs);
    this.task = (fn, options) => {
      const scope = this.requireCurrent("task");
      if (typeof fn !== "function") throw new TypeError("reactive-db: task expects a function.");
      if (scope.nextTask !== undefined) {
        throw new Error(`reactive-db: ${this.pathOf(scope)} registered more than one task.`);
      }
      scope.nextTask = { fn, label: options?.label };
    };
  }

  protected runRoot(): void {
    this.watch(this.q, this.task);
  }

  protected override afterSuccess(scope: Scope): void {
    const prev = scope.task;
    if (prev !== undefined) abortTask(prev, "restarted");
    scope.task = undefined;
    if (scope.nextTask !== undefined) {
      scope.task = {
        fn: scope.nextTask.fn,
        scope,
        label: scope.nextTask.label,
        restartOf: prev === undefined ? null : (prev.id ?? prev.restartOf),
        id: undefined,
        controller: undefined,
        cancelled: false,
        onAbort: undefined,
      };
      this.starts.push(scope.task);
    }
    scope.nextTask = undefined;
  }

  protected override afterFailure(scope: Scope): void {
    scope.nextTask = undefined;
  }

  protected override onDispose(scope: Scope): void {
    if (scope.task !== undefined) abortTask(scope.task, this.disposeReason);
    scope.task = undefined;
  }

  takeStarts(): TaskHandle[] {
    const starts = this.starts.filter((t) => !t.cancelled && !t.scope.disposed);
    this.starts = [];
    return starts;
  }
}

export function abortTask(task: TaskHandle, reason: AbortReason): void {
  if (task.cancelled) return;
  task.cancelled = true;
  task.controller?.abort();
  task.onAbort?.(reason);
}
