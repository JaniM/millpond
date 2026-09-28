export type { Aggregate, AggregateConfig, Reducer, ScopeApi, ScopeOptions } from "./aggregate";
export { aggregate } from "./aggregate";
export type {
  AnyDb,
  CreateDbOptions,
  Db,
  ErrorInfo,
  OpFn,
  OpsTree,
  ReadonlyDb,
  Unsubscribe,
} from "./db";
export { createDb } from "./db";
export type { Effect, EffectConfig, Task, TaskContext } from "./effect";
export { effect } from "./effect";
export type { Feature, FeatureConfig } from "./feature";
export { feature } from "./feature";
export type { Op, Tx } from "./op";
export { op } from "./op";
export type { Query, Step } from "./query";
export { count, max, min, sum } from "./reducers";
export type { InferRow, Schema, StandardSchemaV1 } from "./schema";
export type {
  Indexable,
  IndexableKeys,
  IndexColumns,
  IndexMap,
  InsertRow,
  RowOf,
  Table,
  TableFor,
  TableOptions,
  TableQueries,
} from "./table";
export { table } from "./table";

/** The package version. */
export const VERSION = "0.0.0";
