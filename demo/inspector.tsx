import { useEffect, useMemo, useRef } from "react";
import { type EffectRow, sys, type TableRow, type TaskRow } from "../src/index";
import { useQuery } from "../src/react";
import { formatTime } from "./util";

// The right-hand panels every demo shares: each effect's tasks and every
// registered table's live contents, read from the sys.* introspection tables.

// --- Effects --------------------------------------------------------------------------

export function Effects() {
  const effects = useQuery(sys.effects.all());
  return (
    <>
      <header className="column-header">
        <h1>Effects</h1>
        <span className="muted">sys.effects · sys.tasks</span>
      </header>
      {effects.map((e) => (
        <EffectCard key={e.name} effect={e} />
      ))}
    </>
  );
}

function EffectCard({ effect }: { effect: EffectRow }) {
  const tasks = useQuery(sys.tasks.byEffect.effectEq(effect.name));
  const sorted = useMemo(() => {
    // Running tasks first, oldest first; then finished ones, newest first.
    const running = tasks.filter((t) => t.status === "running");
    const finished = tasks.filter((t) => t.status !== "running");
    running.sort((a, b) => a.startedAt - b.startedAt);
    finished.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    return [...running, ...finished];
  }, [tasks]);

  return (
    <div className="effect-card">
      <header>
        <h2>{effect.name}</h2>
        {effect.state === "disabled" && <span className="badge">disabled</span>}
        <span className="muted">
          {effect.running} running · {effect.started} started · {effect.done} done ·{" "}
          {effect.aborted} aborted · {effect.failed} failed
        </span>
      </header>
      <p className="muted about">watches {effect.inputs.join(", ")}</p>
      {sorted.length === 0 ? (
        <p className="empty small">no tasks yet</p>
      ) : (
        <ul className="task-list">
          {sorted.map((t) => (
            <TaskItem key={t.id} task={t} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TaskItem({ task }: { task: TaskRow }) {
  const { status, note } = task;
  // Notes from the demo's `wait` end in a duration, which drives the bar.
  const wait = note?.match(/([\d.]+)s$/);
  return (
    <li className={`task task-${status}`} title={`#${task.id} ${task.path}`}>
      <span className={`pill pill-${status}`}>{status}</span>
      <span className="task-label">
        {task.label}
        {task.restartOf !== null && <span className="muted"> ↻ #{task.restartOf}</span>}
      </span>
      {status === "running" && task.abortReason !== null ? (
        <span className="muted">stopping ({task.abortReason})</span>
      ) : status === "running" ? (
        <span className="task-wait">
          {wait && (
            <span className="task-bar">
              {/* Keyed by the note, so the animation restarts with each wait. */}
              <span key={note} style={{ animationDuration: `${Number(wait[1]) * 1000}ms` }} />
            </span>
          )}
          {note ?? "working"}
        </span>
      ) : (
        <span className="muted">
          {status === "aborted" && `${task.abortReason ?? "abort error"} · `}
          {status === "failed" && `${String(task.error)} · `}
          {seconds((task.endedAt ?? task.startedAt) - task.startedAt)}
        </span>
      )}
    </li>
  );
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

// --- Tables ---------------------------------------------------------------------------

type AnyRow = Record<string, unknown>;

/**
 * Results come back in unspecified order, so a demo can pick each table's
 * display order by its registered name. Other tables sort by key.
 */
export type Sorts = Record<string, (a: AnyRow, b: AnyRow) => number>;

export function Tables({ sorts = {} }: { sorts?: Sorts }) {
  const tables = useQuery(sys.tables.all());
  return (
    <>
      <header className="column-header">
        <h1>Tables</h1>
        <span className="muted">sys.tables · changed rows flash</span>
      </header>
      {tables.map((t) => (
        <TableCard key={t.name} info={t} sort={sorts[t.name]} />
      ))}
    </>
  );
}

function TableCard({ info, sort }: { info: TableRow; sort?: Sorts[string] }) {
  const rows = useQuery(info.table.all());
  const sorted = useMemo(() => {
    const byKey = (a: AnyRow, b: AnyRow) => String(a[info.key]).localeCompare(String(b[info.key]));
    return [...rows].sort(sort ?? byKey);
  }, [rows, info, sort]);
  const columns = useMemo(() => {
    const cols = new Set<string>([info.key]);
    for (const row of rows) for (const k of Object.keys(row)) cols.add(k);
    return [...cols];
  }, [rows, info]);

  return (
    <div className="table-card">
      <header>
        <h2>{info.name}</h2>
        {info.kind === "aggregate" && <span className="badge">aggregate</span>}
        <span className="muted">
          {rows.length} {rows.length === 1 ? "row" : "rows"}
        </span>
      </header>
      {rows.length === 0 ? (
        <p className="empty small">empty</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <DataRow key={String(row[info.key])} row={row} columns={columns} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DataRow({ row, columns }: { row: AnyRow; columns: string[] }) {
  const ref = useRef<HTMLTableRowElement>(null);
  // Rows are immutable, so a new object means the row was inserted or updated.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `row` identity is the trigger.
  useEffect(() => {
    ref.current?.animate(
      [{ backgroundColor: "var(--flash)" }, { backgroundColor: "transparent" }],
      { duration: 1200, easing: "ease-out" },
    );
  }, [row]);
  return (
    <tr ref={ref}>
      {columns.map((c) => (
        <td key={c}>
          <Cell field={c} value={row[c]} />
        </td>
      ))}
    </tr>
  );
}

function Cell({ field, value }: { field: string; value: unknown }) {
  if (value === null || value === undefined) return <span className="null">null</span>;
  if (typeof value === "number" && field.endsWith("At")) return <>{formatTime(value)}</>;
  if (field === "status") return <span className={`pill pill-${value}`}>{String(value)}</span>;
  return <>{String(value)}</>;
}
