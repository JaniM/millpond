import { type AnyRow, internalOf, PK_INDEX, type TableDef } from "./internal";
import type { TableState } from "./store";
import {
  type AbortReason,
  type EffectRow,
  SYS_NAMES,
  sys,
  type TableRow,
  type TaskRow,
  type TaskStatus,
} from "./sys";

/** What the tracker needs from its db. */
export interface IntrospectionHost {
  /** The db's state for a system table. */
  stateOf(def: TableDef): TableState;
  /** Writes (or, with `undefined`, deletes) a system row and schedules a flush. */
  write(ts: TableState, key: unknown, row: AnyRow | undefined): void;
}

/** A started task's handle into `sys.tasks`. */
export interface TaskRecord {
  readonly id: number;
  readonly effect: string;
  ended: boolean;
}

type Counter = "running" | "started" | "done" | "failed" | "aborted";

/** Maintains one db's system tables. */
export class Introspection {
  private nextId = 1;
  private readonly tasks: TableState;
  private readonly effects: TableState;
  /** Finished task ids per effect, oldest first. */
  private readonly finished = new Map<string, number[]>();

  constructor(
    private readonly host: IntrospectionHost,
    private readonly history: number,
  ) {
    this.tasks = host.stateOf(internalOf(sys.tasks, "table"));
    this.effects = host.stateOf(internalOf(sys.effects, "table"));
  }

  /** Fills `sys.tables` and `sys.effects` when the db is created. */
  init(
    tables: readonly { state: TableState; value: object }[],
    effects: readonly { name: string; inputs: readonly string[] }[],
  ): void {
    const tablesState = this.host.stateOf(internalOf(sys.tables, "table"));
    for (const { state, value } of tables) {
      if (SYS_NAMES.has(state.def)) continue;
      const indexes: Record<string, readonly string[]> = {};
      for (const [name, cols] of state.def.indexes) if (name !== PK_INDEX) indexes[name] = cols;
      const row: TableRow = {
        name: state.name,
        kind: state.def.aggregate === undefined ? "table" : "aggregate",
        key: state.def.key,
        indexes,
        table: value as TableRow["table"],
      };
      this.host.write(tablesState, row.name, row);
    }
    for (const { name, inputs } of effects) {
      const row: EffectRow = {
        name,
        inputs,
        state: "active",
        running: 0,
        started: 0,
        done: 0,
        failed: 0,
        aborted: 0,
      };
      this.host.write(this.effects, name, row);
    }
  }

  start(effect: string, path: string, label: string | undefined, restartOf: number | null) {
    const record: TaskRecord = { id: this.nextId++, effect, ended: false };
    const row: TaskRow = {
      id: record.id,
      effect,
      path,
      label: label ?? path,
      status: "running",
      abortReason: null,
      restartOf,
      note: null,
      error: null,
      startedAt: Date.now(),
      endedAt: null,
    };
    this.host.write(this.tasks, record.id, row);
    this.count(effect, { running: 1, started: 1 });
    return record;
  }

  /** Records that the engine aborted a running task; its code may still be running. */
  aborted(record: TaskRecord, abortReason: AbortReason): void {
    if (!record.ended) this.patchTask(record, { abortReason });
  }

  /** Records how a task's code settled. Only the first call counts. */
  end(record: TaskRecord, status: Exclude<TaskStatus, "running">, error: unknown = null): void {
    if (record.ended) return;
    record.ended = true;
    this.patchTask(record, { status, endedAt: Date.now(), error });
    this.count(record.effect, { running: -1, [status]: 1 });

    let ids = this.finished.get(record.effect);
    if (ids === undefined) {
      ids = [];
      this.finished.set(record.effect, ids);
    }
    ids.push(record.id);
    while (ids.length > this.history) this.host.write(this.tasks, ids.shift(), undefined);
  }

  note(record: TaskRecord, note: string | null): void {
    if (!record.ended) this.patchTask(record, { note });
  }

  disable(effect: string): void {
    this.patch(this.effects, effect, { state: "disabled" });
  }

  private patchTask(record: TaskRecord, changes: Partial<TaskRow>): void {
    this.patch(this.tasks, record.id, changes);
  }

  private count(effect: string, deltas: Partial<Record<Counter, number>>): void {
    const row = this.effects.rows.get(effect) as EffectRow | undefined;
    if (row === undefined) return;
    const changes: Partial<EffectRow> = {};
    for (const [k, d] of Object.entries(deltas) as [Counter, number][]) changes[k] = row[k] + d;
    this.patch(this.effects, effect, changes);
  }

  private patch(ts: TableState, key: unknown, changes: AnyRow): void {
    const row = ts.rows.get(key);
    if (row !== undefined) this.host.write(ts, key, { ...row, ...changes });
  }
}
