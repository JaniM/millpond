import { internalOf, type TableDef } from "./internal";
import type { Query } from "./query";
import type { StandardSchemaV1 } from "./schema";
import { type Table, table } from "./table";

// The system tables behind `createDb({ introspect: true })`. They are ordinary
// table definitions, so they are queried like any other table, but only the
// engine writes them (see Introspection in the spec).

/** A task run's state in `sys.tasks`. */
export type TaskStatus = "running" | "done" | "failed" | "aborted";

/** Why the engine aborted a task. */
export type AbortReason = "restarted" | "scopeDisposed" | "effectDisabled";

/** One task run. */
export type TaskRow = {
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
export type EffectRow = {
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
export type AnyTable = Table<AnyRow, unknown> & {
  all(): Query<AnyRow, readonly AnyRow[]>;
  get(key: unknown): Query<AnyRow, AnyRow | undefined>;
};

/** One registered table or aggregate. */
export type TableRow = {
  name: string;
  kind: "table" | "aggregate";
  /** The primary-key field. */
  key: string;
  /** Index name → columns, not counting the primary key. */
  indexes: Readonly<Record<string, readonly string[]>>;
  /** The definition value itself, for querying the table. */
  table: AnyTable;
};

/** Engine-written rows aren't validated; the schema only carries the type. */
function trusted<Row>(): StandardSchemaV1<Row, Row> {
  return {
    "~standard": {
      version: 1,
      vendor: "reactive-db",
      validate: (value) => ({ value: value as Row }),
    },
  };
}

/** The built-in system tables. Reading them requires `createDb({ introspect })`. */
export const sys = {
  tasks: table(trusted<TaskRow>(), {
    key: "id",
    indexes: { byEffect: ["effect", "status"], byStatus: ["status"] },
  }),
  effects: table(trusted<EffectRow>(), { key: "name" }),
  tables: table(trusted<TableRow>(), { key: "name", indexes: { byKind: ["kind"] } }),
};

/** Each system table's definition and its name. */
export const SYS_NAMES: ReadonlyMap<TableDef, string> = new Map(
  Object.entries(sys).map(([key, t]) => [internalOf<TableDef>(t, "table"), `sys.${key}`]),
);
