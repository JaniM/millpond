import { A as Indexable, B as Schema, C as AggregateConfig, D as aggregate, E as ScopeOptions, F as TableFor, H as Query, I as TableOptions, L as TableQueries, M as InsertRow, N as RowOf, O as IndexColumns, P as Table, R as table, S as Aggregate, T as ScopeApi, U as Step, V as StandardSchemaV1, _ as TaskOptions, a as OpFn, b as Tx, c as Unsubscribe, d as FeatureConfig, f as feature, g as TaskContext, h as Task, i as ErrorInfo, j as IndexableKeys, k as IndexMap, l as createDb, m as EffectConfig, n as CreateDbOptions, o as OpsTree, p as Effect, r as Db, s as ReadonlyDb, t as AnyDb, u as Feature, v as effect, w as Reducer, x as op, y as Op, z as InferRow } from "./db-DJXBIulF.cjs";
//#region src/reducers.d.ts
/** Counts rows. O(1) per change. */
export declare const count: Reducer<unknown, number>;
/** Sums numeric values. O(1) per change. */
export declare const sum: Reducer<number, number>;
/**
 * Smallest value in the group, or `undefined` when empty. Keeps every child's
 * value in a sorted array, so O(log n) per change and O(n) memory.
 */
export declare const min: Reducer<number, number[], number | undefined>;
/** Largest value in the group, or `undefined` when empty. See `min`. */
export declare const max: Reducer<number, number[], number | undefined>;
//#endregion
//#region src/sys.d.ts
/** A task run's state in `sys.tasks`. */
type TaskStatus = "running" | "done" | "failed" | "aborted";
/** Why the engine aborted a task. */
type AbortReason = "restarted" | "scopeDisposed" | "effectDisabled";
/** One task run. */
type TaskRow = {
  /** Increases with each run; unique within the db. */
  id: number;
  /** The effect's registered name, such as `chat.loadRoom`. */
  effect: string;
  /** The task's scope path, the same string `onError` receives as `source`. */
  path: string;
  /** From `task(fn, { label })`, or `path` when none is given. */
  label: string;
  status: TaskStatus;
  /** Set when the engine aborted the task. */
  abortReason: AbortReason | null;
  /** The run this one replaced when its scope reran. */
  restartOf: number | null;
  /** The last value passed to `ctx.note`. */
  note: string | null;
  /** What a failed task threw. */
  error: unknown;
  startedAt: number;
  /** `null` while running. */
  endedAt: number | null;
};
/** One registered effect. */
type EffectRow = {
  name: string;
  /** Registered names of the effect's inputs. */
  inputs: readonly string[];
  /** `"disabled"` once the effect has hit the flush cap. */
  state: "active" | "disabled";
  running: number;
  started: number;
  done: number;
  failed: number;
  aborted: number;
};
type AnyRow = Record<string, unknown>;
/** A registered table of unknown shape, as listed in `sys.tables`. */
type AnyTable = Table<AnyRow, unknown> & {
  all(): Query<AnyRow, readonly AnyRow[]>;
  get(key: unknown): Query<AnyRow, AnyRow | undefined>;
};
/** One registered table or aggregate. */
type TableRow = {
  name: string;
  kind: "table" | "aggregate";
  /** The primary-key field. */
  key: string;
  /** Index name → columns, not counting the primary key. */
  indexes: Readonly<Record<string, readonly string[]>>;
  /** The definition value itself, for querying the table. */
  table: AnyTable;
};
/** The built-in system tables. Reading them requires `createDb({ introspect })`. */
export declare const sys: {
  tasks: TableFor<TaskRow, "id", {
    readonly byEffect: readonly ["effect", "status"];
    readonly byStatus: readonly ["status"];
  }, TaskRow>;
  effects: TableFor<EffectRow, "name", Record<never, never>, EffectRow>;
  tables: TableFor<TableRow, "name", {
    readonly byKind: readonly ["kind"];
  }, TableRow>;
};
//#endregion
//#region src/index.d.ts
/** The package version. */
export declare const VERSION = "0.0.0";
//#endregion
export { type AbortReason, type Aggregate, type AggregateConfig, type AnyDb, type AnyTable, type CreateDbOptions, type Db, type Effect, type EffectConfig, type EffectRow, type ErrorInfo, type Feature, type FeatureConfig, type IndexColumns, type IndexMap, type Indexable, type IndexableKeys, type InferRow, type InsertRow, type Op, type OpFn, type OpsTree, type Query, type ReadonlyDb, type Reducer, type RowOf, type Schema, type ScopeApi, type ScopeOptions, type StandardSchemaV1, type Step, type Table, type TableFor, type TableOptions, type TableQueries, type TableRow, type Task, type TaskContext, type TaskOptions, type TaskRow, type TaskStatus, type Tx, type Unsubscribe, aggregate, createDb, effect, feature, op, table };
//# sourceMappingURL=index.d.cts.map