import type { Feature } from "./feature";
import {
  type AnyRow,
  abortError,
  deepEqual,
  type EffectDef,
  type FeatureDef,
  internalOf,
  isAbortError,
  isThenable,
  matchesQuery,
  type OpDef,
  type QueryInfo,
  sameResult,
  shallowEqual,
  type TableDef,
} from "./internal";
import { Introspection, type TaskRecord } from "./introspect";
import type { Op } from "./op";
import type { Query } from "./query";
import type { StandardSchemaV1 } from "./schema";
import {
  AggregateEngine,
  EffectEngine,
  type ScopeEngine,
  type ScopeHost,
  type TaskHandle,
} from "./scope";
import { Registry, TableState } from "./store";
import { SYS_NAMES } from "./sys";

/** A read-only view of the db, as seen from tasks and outside code. */
export interface ReadonlyDb {
  /** One-shot read of a query against the latest committed state. */
  read<Row, Result>(query: Query<Row, Result>): Result;
}

/** Unsubscribe handle returned by `subscribe`. */
export type Unsubscribe = () => void;

/**
 * A db handle without the compile-time `ops` tree. Every `Db<Features>` is
 * assignable to it, so it is the type to use where the feature set is not
 * known statically — a provider, a context, or a shared reference. (A concrete
 * `Db<Features>` is not assignable to another `Db` with different features,
 * because op argument types are contravariant.)
 */
export interface AnyDb {
  read<Row, Result>(query: Query<Row, Result>): Result;
  subscribe<Row, Result>(
    query: Query<Row, Result>,
    listener: (result: Result) => void,
  ): Unsubscribe;
  run<Args>(op: Op<Args>, args: Args): void;
  dispose(): void;
}

/** A bound op call: `(args) => void`, or `() => void` for an `Op<void>`. */
// biome-ignore lint/suspicious/noConfusingVoidType: the `[void]` tuple is an exact-void check that distinguishes argument-free ops.
export type OpFn<Args> = [Args] extends [void] ? () => void : (args: Args) => void;

/** The `db.ops.<feature>.<op>(args)` convenience tree, typed from the features. */
export type OpsTree<Features extends Record<string, Feature>> = {
  [F in keyof Features]: Features[F] extends Feature<infer _Tables, infer Ops, infer _Effects>
    ? { [K in keyof Ops]: Ops[K] extends Op<infer Args> ? OpFn<Args> : never }
    : never;
};

/** Passed to `onError`; `source` is the registered name of what failed. */
export interface ErrorInfo<Features extends Record<string, Feature> = Record<string, Feature>> {
  db: Db<Features>;
  source: string;
}

export interface CreateDbOptions<Features extends Record<string, Feature>> {
  features: Features;
  /** Validate every write against its schema. On by default. */
  validate?: boolean;
  /** Shallow-freeze every stored row. On by default. */
  freeze?: boolean;
  /**
   * Maintain the `sys.*` system tables. Off by default. `history` is how many
   * finished task runs to keep per effect (20 by default).
   */
  introspect?: boolean | { history?: number };
  /** Runs after the flush; may call ops, e.g. to record the error. */
  onError?: (err: unknown, info: ErrorInfo<Features>) => void;
}

export interface Db<Features extends Record<string, Feature> = Record<string, Feature>>
  extends AnyDb {
  /** The `db.ops.<feature>.<op>()` convenience tree. */
  ops: OpsTree<Features>;
}

export function createDb<const Features extends Record<string, Feature>>(
  options: CreateDbOptions<Features>,
): Db<Features> {
  const engine = new Engine(options as CreateDbOptions<Record<string, Feature>>);
  engines.set(engine.db, engine);
  return engine.db as Db<Features>;
}

const engines = new WeakMap<AnyDb, Engine>();

/**
 * Internal, for tests: how many query results the db is caching. Only watched
 * queries (subscribed, or read by a scope) are cached. Not exported publicly.
 */
export function cachedQueryCount(db: AnyDb): number {
  const engine = engines.get(db);
  if (engine === undefined) throw new TypeError("reactive-db: not a db created by createDb.");
  return engine.cachedQueryCount;
}

// --- Engine --------------------------------------------------------------------------

/** Consecutive flushes in which an effect may restart its tasks. */
const FLUSH_CAP = 100;

/** Finished task runs kept per effect in `sys.tasks` by default. */
const DEFAULT_HISTORY = 20;

const DELETED: unique symbol = Symbol("deleted");
type Slot = AnyRow | typeof DELETED;

interface Listener {
  readonly fn: (result: unknown) => void;
  last: unknown;
}

/**
 * A cached query result, shared by every equal query. It exists only while
 * something watches the query — a subscriber or a scope's `q.read` — so the
 * result keeps its identity for them; one-shot reads compute fresh.
 */
interface CacheEntry {
  readonly query: QueryInfo;
  result: unknown;
  dirty: boolean;
  readonly listeners: Set<Listener>;
  /** Scope reads holding this entry. */
  scopeRefs: number;
}

interface RegisteredOp {
  readonly def: OpDef;
  readonly name: string;
}

const fmt = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : String(v));

class Engine implements ScopeHost {
  readonly db: Db;
  private readonly validate: boolean;
  private readonly freeze: boolean;
  private readonly onError: ((err: unknown, info: ErrorInfo) => void) | undefined;

  private disposed = false;
  private readonly tables = new Map<TableDef, TableState>();
  private readonly ops = new Map<object, RegisteredOp>();
  private readonly aggregates: AggregateEngine[] = [];
  private readonly aggregateOf = new Map<TableDef, AggregateEngine>();
  private readonly effects: EffectEngine[] = [];
  private readonly dependents = new Map<TableDef, ScopeEngine[]>();
  private readonly introspection: Introspection | undefined;

  private readonly cache = new Map<string, CacheEntry>();
  get cachedQueryCount(): number {
    return this.cache.size;
  }
  private readonly cacheWatchers = new Registry<CacheEntry>();
  private dirtyEntries = new Set<CacheEntry>();

  /** Nonzero while subscribers, compute or watch functions run. */
  private noWrite = 0;
  private tx: Tx | undefined;
  private flushScheduled = false;
  private inFlush = false;
  private nextChained = false;
  private errors: { err: unknown; source: string }[] = [];

  constructor(options: CreateDbOptions<Record<string, Feature>>) {
    this.validate = options.validate ?? true;
    this.freeze = options.freeze ?? true;
    this.onError = options.onError as typeof this.onError;
    const { introspect } = options;
    if (introspect) {
      const history = typeof introspect === "object" ? introspect.history : undefined;
      for (const [def, name] of SYS_NAMES) this.tables.set(def, new TableState(def, name));
      this.introspection = new Introspection(
        {
          stateOf: (def) => this.tables.get(def) as TableState,
          write: (ts, key, row) => this.writeSystem(ts, key, row),
        },
        history ?? DEFAULT_HISTORY,
      );
    }
    this.register(options.features ?? {});
    const readonlyDb: ReadonlyDb = { read: (q) => this.read(q) };
    this.readonlyDb = readonlyDb;
    this.db = {
      ops: this.opsTree(options.features ?? {}),
      read: (q) => this.read(q),
      subscribe: (q, listener) => this.subscribe(q, listener),
      run: (op, args) => this.run(op, args),
      dispose: () => this.dispose(),
    } as Db;
  }

  private readonly readonlyDb: ReadonlyDb;

  // --- Registration -----------------------------------------------------------------

  private register(features: Record<string, Feature>): void {
    const effects: [string, EffectDef, object][] = [];
    const tableValues: { state: TableState; value: object }[] = [];
    const seen = new Set<object>();
    const claim = (value: object, name: string) => {
      if (seen.has(value)) {
        throw new Error(`reactive-db: ${name} is already registered under another name.`);
      }
      seen.add(value);
    };
    for (const [fname, feature] of Object.entries(features)) {
      const fd = internalOf<FeatureDef>(feature, "feature");
      for (const [key, t] of Object.entries(fd.tables)) {
        const def = internalOf<TableDef>(t, "table");
        const sysName = SYS_NAMES.get(def);
        if (sysName !== undefined) {
          throw new Error(
            `reactive-db: ${sysName} is a system table and cannot be registered as ${fname}.${key}.`,
          );
        }
        claim(def, `${fname}.${key}`);
        const state = new TableState(def, `${fname}.${key}`);
        this.tables.set(def, state);
        tableValues.push({ state, value: t });
      }
      for (const [key, o] of Object.entries(fd.ops)) {
        claim(o, `${fname}.${key}`);
        this.ops.set(o, { def: internalOf<OpDef>(o, "op"), name: `${fname}.${key}` });
      }
      for (const [key, e] of Object.entries(fd.effects)) {
        claim(e, `${fname}.${key}`);
        effects.push([`${fname}.${key}`, internalOf<EffectDef>(e, "effect"), e]);
      }
    }

    const inputsOf = (name: string, inputs: readonly object[]) => {
      const defs = new Set<TableDef>();
      for (const input of inputs) {
        const def = internalOf<TableDef>(input, "table");
        if (!this.tables.has(def)) {
          const sysName = SYS_NAMES.get(def);
          throw new Error(
            sysName === undefined
              ? `reactive-db: ${name} has an input that is not registered with the db.`
              : `reactive-db: ${name} reads ${sysName}, which requires createDb({ introspect: true }).`,
          );
        }
        defs.add(def);
      }
      return defs;
    };

    // Effects may not watch system tables: a task's own row would restart it.
    const effectInputs = effects.map(([name, def]) => {
      const inputs = inputsOf(name, def.inputs);
      for (const input of inputs) {
        const sysName = SYS_NAMES.get(input);
        if (sysName !== undefined) {
          throw new Error(`reactive-db: ${name} cannot watch the system table ${sysName}.`);
        }
      }
      return inputs;
    });

    // Filled before aggregates exist, so nothing downstream sees these writes.
    this.introspection?.init(
      tableValues,
      effects.map(([name], i) => ({
        name,
        inputs: [...(effectInputs[i] ?? [])].map((d) => this.tables.get(d)?.name ?? ""),
      })),
    );

    // Aggregates, in dependency order.
    const state = new Map<TableDef, "visiting" | "done">();
    const visit = (def: TableDef) => {
      const agg = def.aggregate;
      if (agg === undefined || state.get(def) === "done") return;
      const ts = this.tables.get(def) as TableState;
      if (state.get(def) === "visiting") {
        throw new Error(`reactive-db: aggregate ${ts.name} depends on itself.`);
      }
      state.set(def, "visiting");
      const inputs = inputsOf(ts.name, agg.inputs);
      for (const input of inputs) visit(input);
      const engine = new AggregateEngine(this, ts.name, inputs, def, agg.compute, {
        prepare: (row) => this.prepare(ts, { ...row }),
        write: (key, row) => this.writeOutput(ts, key, row),
      });
      for (const input of inputs) {
        const up = this.aggregateOf.get(input);
        if (up !== undefined) engine.upstream.push(up);
      }
      this.aggregates.push(engine);
      this.aggregateOf.set(def, engine);
      this.addDependent(engine);
      state.set(def, "done");
    };
    for (const def of this.tables.keys()) visit(def);

    for (const [i, [name, def]] of effects.entries()) {
      const engine = new EffectEngine(this, name, effectInputs[i] ?? new Set(), def.watch);
      this.effects.push(engine);
      this.addDependent(engine);
    }
  }

  private addDependent(engine: ScopeEngine): void {
    for (const input of engine.inputs) {
      let list = this.dependents.get(input);
      if (list === undefined) {
        list = [];
        this.dependents.set(input, list);
      }
      list.push(engine);
    }
  }

  private opsTree(features: Record<string, Feature>): Record<string, Record<string, unknown>> {
    const tree: Record<string, Record<string, unknown>> = {};
    for (const [fname, feature] of Object.entries(features)) {
      const branch: Record<string, unknown> = {};
      for (const [key, o] of Object.entries(internalOf<FeatureDef>(feature, "feature").ops)) {
        branch[key] = (args: unknown) => this.run(o as Op<unknown>, args);
      }
      tree[fname] = branch;
    }
    return tree;
  }

  // --- Guards -------------------------------------------------------------------------

  private assertAlive(): void {
    if (this.disposed) throw new Error("reactive-db: the db has been disposed.");
  }

  /** The state of a registered table, brought up to date if it's an aggregate. */
  readable(def: TableDef): TableState {
    const ts = this.tables.get(def);
    if (ts === undefined) throw this.unregistered(def);
    const agg = this.aggregateOf.get(def);
    if (agg !== undefined) this.ensureFresh(agg);
    return ts;
  }

  writable(table: unknown): TableState {
    const def = internalOf<TableDef>(table, "table");
    const sysName = SYS_NAMES.get(def);
    if (sysName !== undefined) {
      throw new Error(`reactive-db: ${sysName} is a system table, which only the db writes.`);
    }
    const ts = this.tables.get(def);
    if (ts === undefined) throw this.unregistered(def);
    if (def.aggregate !== undefined) {
      throw new Error(`reactive-db: ${ts.name} is an aggregate, which is read-only.`);
    }
    return ts;
  }

  private unregistered(def: TableDef): Error {
    const sysName = SYS_NAMES.get(def);
    return new Error(
      sysName === undefined
        ? "reactive-db: this table is not registered with the db."
        : `reactive-db: reading ${sysName} requires createDb({ introspect: true }).`,
    );
  }

  private ensureFresh(agg: AggregateEngine): void {
    if (agg.busy) return;
    for (const up of agg.upstream) this.ensureFresh(up);
    agg.update();
  }

  guard<T>(fn: () => T): T {
    this.noWrite++;
    try {
      return fn();
    } finally {
      this.noWrite--;
    }
  }

  // --- Validation ---------------------------------------------------------------------

  prepare(ts: TableState, row: AnyRow): AnyRow {
    if (this.validate) {
      let res: StandardSchemaV1.Result<unknown> | Promise<StandardSchemaV1.Result<unknown>>;
      try {
        res = ts.def.schema["~standard"].validate(row);
      } catch (e) {
        throw new Error(`reactive-db: ${ts.name}: the schema failed to validate synchronously.`, {
          cause: e,
        });
      }
      if (isThenable(res)) {
        (res as Promise<unknown>).then(undefined, () => {});
        throw new Error(
          `reactive-db: ${ts.name} has an async schema; ops are synchronous, so it cannot be used.`,
        );
      }
      if (res.issues !== undefined) {
        const detail = res.issues
          .map((i) => {
            const path = i.path?.map((p) => (typeof p === "object" ? p.key : p)).join(".");
            return path ? `${path}: ${i.message}` : i.message;
          })
          .join("; ");
        throw new Error(`reactive-db: invalid row for ${ts.name}: ${detail}`);
      }
      if (!deepEqual(res.value, row)) {
        throw new Error(
          `reactive-db: ${ts.name}: the schema's output differs from its input. Schemas only validate, so defaults and transforms are not supported.`,
        );
      }
    }
    if (this.freeze) Object.freeze(row);
    return row;
  }

  // --- Reads --------------------------------------------------------------------------

  read<Row, Result>(query: Query<Row, Result>): Result {
    this.assertAlive();
    return this.readQuery(internalOf<QueryInfo>(query, "query")) as Result;
  }

  /**
   * A committed read. A watched query reads through its cache entry, so an
   * unchanged result keeps its identity; anything else is computed fresh.
   */
  readQuery(q: QueryInfo): unknown {
    const ts = this.readable(q.table);
    const entry = this.cache.get(q.key);
    if (entry === undefined) return ts.read(q);
    if (entry.dirty) {
      const next = ts.read(q);
      if (!sameResult(entry.result, next)) entry.result = next;
      entry.dirty = false;
    }
    return entry.result;
  }

  /** The cache entry for a query, created on first use. */
  private entryFor(q: QueryInfo): CacheEntry {
    let entry = this.cache.get(q.key);
    if (entry === undefined) {
      const result = this.readable(q.table).read(q);
      entry = { query: q, result, dirty: false, listeners: new Set(), scopeRefs: 0 };
      this.cache.set(q.key, entry);
      this.cacheWatchers.add(entry);
    }
    return entry;
  }

  /** Drops an entry once nothing watches it any more. */
  private releaseEntry(entry: CacheEntry): void {
    if (entry.listeners.size > 0 || entry.scopeRefs > 0) return;
    if (this.cache.get(entry.query.key) !== entry) return;
    this.cache.delete(entry.query.key);
    this.cacheWatchers.remove(entry);
    this.dirtyEntries.delete(entry);
  }

  retain(q: QueryInfo): void {
    this.entryFor(q).scopeRefs++;
  }

  release(q: QueryInfo): void {
    const entry = this.cache.get(q.key);
    if (entry === undefined) return;
    entry.scopeRefs--;
    this.releaseEntry(entry);
  }

  rows(q: QueryInfo): AnyRow[] {
    const result = this.readable(q.table).read(q);
    if (q.single) return result === undefined ? [] : [result as AnyRow];
    return result as AnyRow[];
  }

  // --- Subscriptions ------------------------------------------------------------------

  subscribe<Row, Result>(query: Query<Row, Result>, listener: (result: Result) => void) {
    this.assertAlive();
    const q = internalOf<QueryInfo>(query, "query");
    const entry = this.entryFor(q);
    const result = this.readQuery(q);
    const l: Listener = { fn: listener as (r: unknown) => void, last: result };
    entry.listeners.add(l);
    this.callListener(l, result, q);
    return () => {
      if (entry.listeners.delete(l)) this.releaseEntry(entry);
    };
  }

  private callListener(l: Listener, result: unknown, q: QueryInfo): void {
    try {
      this.guard(() => l.fn(result));
    } catch (e) {
      this.report(e, `${this.tables.get(q.table)?.name ?? "query"} subscriber`);
    }
  }

  // --- Writes -------------------------------------------------------------------------

  run<Args>(op: Op<Args>, args: Args): void {
    this.assertAlive();
    if (this.noWrite > 0) {
      throw new Error(
        "reactive-db: ops cannot be called from subscribers, compute or watch functions.",
      );
    }
    if (this.tx !== undefined) {
      throw new Error("reactive-db: use tx.run to call an op from inside another op.");
    }
    const reg = this.opOf(op);
    const tx = new Tx(this);
    this.tx = tx;
    try {
      tx.exec(reg, args);
    } finally {
      this.tx = undefined;
      tx.closed = true;
    }
    this.commit(tx.overlay);
  }

  opOf(op: unknown): RegisteredOp {
    const reg = typeof op === "object" && op !== null ? this.ops.get(op) : undefined;
    if (reg === undefined) throw new Error("reactive-db: this op is not registered with the db.");
    return reg;
  }

  private commit(overlay: Map<TableState, Map<unknown, Slot>>): void {
    let changed = false;
    for (const [ts, slots] of overlay) {
      for (const [key, slot] of slots) {
        const before = ts.rows.get(key);
        if (slot === DELETED) {
          if (before === undefined) continue;
          ts.delete(key);
          this.recordChange(ts, key, before, undefined);
        } else {
          ts.set(key, slot);
          this.recordChange(ts, key, before, slot);
        }
        changed = true;
      }
    }
    if (changed) this.scheduleFlush(true);
  }

  /** Writes one aggregate output row if it differs from the stored one. */
  private writeOutput(ts: TableState, key: unknown, row: AnyRow | undefined): void {
    const before = ts.rows.get(key);
    if (row === undefined) {
      if (before === undefined) return;
      ts.delete(key);
    } else {
      if (before !== undefined && shallowEqual(before, row)) return;
      ts.set(key, row);
    }
    this.recordChange(ts, key, before, row);
    if (!this.inFlush) this.scheduleFlush(false);
  }

  /** Writes one system row on the db's behalf, outside any op. */
  private writeSystem(ts: TableState, key: unknown, row: AnyRow | undefined): void {
    if (this.disposed) return;
    const before = ts.rows.get(key);
    if (row === undefined) {
      if (before === undefined) return;
      ts.delete(key);
    } else {
      if (this.freeze) Object.freeze(row);
      ts.set(key, row);
    }
    this.recordChange(ts, key, before, row);
    this.scheduleFlush(false);
  }

  private recordChange(
    ts: TableState,
    key: unknown,
    before: AnyRow | undefined,
    after: AnyRow | undefined,
  ): void {
    const hit = new Set<CacheEntry>();
    if (before !== undefined) this.cacheWatchers.collect(ts.def, before, hit);
    if (after !== undefined) this.cacheWatchers.collect(ts.def, after, hit);
    for (const entry of hit) {
      entry.dirty = true;
      if (entry.listeners.size > 0) this.dirtyEntries.add(entry);
    }
    for (const engine of this.dependents.get(ts.def) ?? [])
      engine.record(ts.def, key, before, after);
  }

  // --- Flush --------------------------------------------------------------------------

  private scheduleFlush(fromOp: boolean): void {
    if (this.inFlush && fromOp) this.nextChained = true;
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;
    if (this.disposed) return;
    const chained = this.nextChained;
    this.nextChained = false;
    this.inFlush = true;
    try {
      // 1. Aggregates, in dependency order.
      for (const agg of this.aggregates) this.ensureFresh(agg);

      // 2. Subscribers whose result changed.
      const dirty = this.dirtyEntries;
      this.dirtyEntries = new Set();
      for (const entry of dirty) {
        if (this.disposed) return;
        if (entry.listeners.size === 0) continue;
        let result: unknown;
        try {
          result = this.readQuery(entry.query);
        } catch (e) {
          this.report(e, "subscriber");
          continue;
        }
        for (const l of [...entry.listeners]) {
          if (this.disposed) return;
          if (Object.is(l.last, result) || !entry.listeners.has(l)) continue;
          l.last = result;
          this.callListener(l, result, entry.query);
        }
      }

      // 3. Effects: abort, and collect tasks to start.
      for (const effect of this.effects) if (!effect.disabled) effect.update();

      // 4. Errors.
      this.deliverErrors();

      // 5. Tasks start after the flush proper.
      this.startTasks(chained);
    } finally {
      this.inFlush = false;
    }
    // Errors reported late in the flush (by onError, or by a task's first
    // synchronous step) are delivered by the next one.
    if (this.errors.length > 0) this.scheduleFlush(false);
  }

  private startTasks(chained: boolean): void {
    for (const effect of this.effects) {
      const starts = effect.disabled ? [] : effect.takeStarts();
      if (starts.length === 0) {
        effect.streak = 0;
        continue;
      }
      effect.streak = chained ? effect.streak + 1 : 1;
      if (effect.streak > FLUSH_CAP) {
        effect.disabled = true;
        effect.disposeReason = "effectDisabled";
        effect.dispose();
        this.introspection?.disable(effect.name);
        this.report(
          new Error(
            `reactive-db: ${effect.name} restarted its tasks in more than ${FLUSH_CAP} consecutive flushes and has been disabled.`,
          ),
          effect.name,
        );
        continue;
      }
      for (const task of starts) {
        if (this.disposed || effect.disabled) return;
        this.startTask(effect, task);
      }
    }
  }

  private startTask(effect: EffectEngine, task: TaskHandle): void {
    if (task.cancelled || task.scope.disposed) return;
    const controller = new AbortController();
    task.controller = controller;
    const { signal } = controller;
    const source = effect.pathOf(task.scope);
    const insp = this.introspection;
    let record: TaskRecord | undefined;
    if (insp !== undefined) {
      const rec = insp.start(effect.name, source, task.label, task.restartOf);
      record = rec;
      task.id = rec.id;
      task.onAbort = (reason) => insp.aborted(rec, reason);
    }
    const ctx = {
      db: this.readonlyDb,
      signal,
      run: (op: Op<unknown>, args: unknown, opts?: { ignoreAbort?: boolean }) => {
        if (signal.aborted && !opts?.ignoreAbort) throw abortError();
        this.run(op, args);
      },
      note: (detail: string | null) => {
        if (record !== undefined) insp?.note(record, detail);
      },
    };
    const done = () => {
      if (record !== undefined) insp?.end(record, "done");
    };
    const fail = (e: unknown) => {
      if (record !== undefined) {
        if (isAbortError(e)) insp?.end(record, "aborted");
        else insp?.end(record, "failed", e);
      }
      if (!isAbortError(e) && !this.disposed) this.report(e, source);
    };
    try {
      const r = task.fn(ctx);
      if (isThenable(r)) r.then(done, fail);
      else done();
    } catch (e) {
      fail(e);
    }
  }

  // --- Errors -------------------------------------------------------------------------

  report(err: unknown, source: string): void {
    if (this.disposed) return;
    this.errors.push({ err, source });
    if (!this.inFlush) this.scheduleFlush(false);
  }

  private deliverErrors(): void {
    const errors = this.errors;
    this.errors = [];
    for (const { err, source } of errors) {
      const onError = this.onError;
      if (onError === undefined) {
        queueMicrotask(() => {
          throw err;
        });
        continue;
      }
      try {
        onError(err, { db: this.db, source });
      } catch (e) {
        queueMicrotask(() => {
          if (e instanceof Error && e.cause === undefined) e.cause = err;
          throw e instanceof Error ? e : new Error(String(e), { cause: err });
        });
      }
    }
  }

  // --- Lifecycle ----------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const effect of this.effects) effect.dispose();
    for (const agg of this.aggregates) agg.dispose();
    for (const entry of this.cache.values()) entry.listeners.clear();
    this.cache.clear();
    this.dirtyEntries.clear();
    this.errors = [];
  }
}

// --- Transactions -----------------------------------------------------------------------

interface Undo {
  readonly ts: TableState;
  readonly key: unknown;
  readonly had: boolean;
  readonly prev: Slot | undefined;
}

/**
 * An op's transaction. Writes go to an overlay over the committed tables, so
 * reads inside the op see them while aggregates still see the op's start. An
 * undo log makes nested ops savepoints.
 */
class Tx {
  readonly overlay = new Map<TableState, Map<unknown, Slot>>();
  private readonly undo: Undo[] = [];
  closed = false;

  constructor(private readonly engine: Engine) {}

  exec(reg: RegisteredOp, args: unknown): void {
    const mark = this.undo.length;
    try {
      const r = reg.def.fn(this, args);
      if (isThenable(r)) {
        (r as Promise<unknown>).then(undefined, () => {});
        throw new Error(`reactive-db: op ${reg.name} returned a promise; ops must be synchronous.`);
      }
    } catch (e) {
      this.rollback(mark);
      throw e;
    }
  }

  private rollback(mark: number): void {
    while (this.undo.length > mark) {
      const u = this.undo.pop() as Undo;
      const slots = this.overlay.get(u.ts) as Map<unknown, Slot>;
      if (u.had) slots.set(u.key, u.prev as Slot);
      else slots.delete(u.key);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("reactive-db: this transaction has already finished.");
  }

  private current(ts: TableState, key: unknown): AnyRow | undefined {
    const slots = this.overlay.get(ts);
    if (slots?.has(key)) {
      const slot = slots.get(key);
      return slot === DELETED ? undefined : slot;
    }
    return ts.rows.get(key);
  }

  private write(ts: TableState, key: unknown, slot: Slot): void {
    let slots = this.overlay.get(ts);
    if (slots === undefined) {
      slots = new Map();
      this.overlay.set(ts, slots);
    }
    this.undo.push({ ts, key, had: slots.has(key), prev: slots.get(key) });
    slots.set(key, slot);
  }

  private withKey(ts: TableState, row: unknown): AnyRow {
    if (typeof row !== "object" || row === null) {
      throw new TypeError(`reactive-db: ${ts.name}: a row must be an object.`);
    }
    const copy: AnyRow = { ...(row as AnyRow) };
    const { key, generate } = ts.def;
    if (copy[key] === undefined && generate !== undefined) copy[key] = generate();
    if (copy[key] === undefined) {
      throw new Error(`reactive-db: ${ts.name}: the row is missing its key "${key}".`);
    }
    return copy;
  }

  insert(table: unknown, row: unknown): unknown {
    this.assertOpen();
    const ts = this.engine.writable(table);
    const next = this.withKey(ts, row);
    const key = next[ts.def.key];
    if (this.current(ts, key) !== undefined) {
      throw new Error(`reactive-db: ${ts.name}: a row with key ${fmt(key)} already exists.`);
    }
    this.write(ts, key, this.engine.prepare(ts, next));
    return key;
  }

  update(table: unknown, key: unknown, patch: unknown): void {
    this.assertOpen();
    const ts = this.engine.writable(table);
    const cur = this.current(ts, key);
    if (cur === undefined) {
      throw new Error(`reactive-db: ${ts.name}: no row with key ${fmt(key)} to update.`);
    }
    const p = (typeof patch === "function" ? patch(cur) : patch) as AnyRow | undefined;
    const keyField = ts.def.key;
    if (p != null && Object.hasOwn(p, keyField) && !Object.is(p[keyField], key)) {
      throw new Error(`reactive-db: ${ts.name}: an update cannot change the key "${keyField}".`);
    }
    this.write(ts, key, this.engine.prepare(ts, { ...cur, ...p }));
  }

  upsert(table: unknown, row: unknown): unknown {
    this.assertOpen();
    const ts = this.engine.writable(table);
    const next = this.withKey(ts, row);
    const key = next[ts.def.key];
    this.write(ts, key, this.engine.prepare(ts, next));
    return key;
  }

  delete(table: unknown, key: unknown): void {
    this.assertOpen();
    const ts = this.engine.writable(table);
    if (this.current(ts, key) === undefined) {
      throw new Error(`reactive-db: ${ts.name}: no row with key ${fmt(key)} to delete.`);
    }
    this.write(ts, key, DELETED);
  }

  read(query: unknown): unknown {
    this.assertOpen();
    const q = internalOf<QueryInfo>(query, "query");
    const ts = this.engine.readable(q.table);
    const slots = this.overlay.get(ts);
    if (slots === undefined || slots.size === 0) return this.engine.readQuery(q);
    if (q.single) return this.current(ts, q.prefix[0]);
    const keyField = ts.def.key;
    const out = (ts.read(q) as AnyRow[]).filter((r) => !slots.has(r[keyField]));
    for (const slot of slots.values()) {
      if (slot !== DELETED && matchesQuery(q, slot)) out.push(slot);
    }
    return out;
  }

  run(op: unknown, args: unknown): void {
    this.assertOpen();
    this.exec(this.engine.opOf(op), args);
  }
}
