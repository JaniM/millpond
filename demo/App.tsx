import { type FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type EffectRow, sys, type TableRow, type TaskRow } from "../src/index";
import { useOp, useQuery } from "../src/react";
import { closeRoom, ME, messages, openRoom, retrySend, roomStats, rooms, sendMessage } from "./db";
import { formatTime, pick } from "./util";

const ROOM_NAMES = ["general", "random", "design", "engineering", "support", "releases", "ops"];

export function App() {
  return (
    <div className="layout">
      <section className="column rooms-column">
        <Rooms />
      </section>
      <section className="column effects-column">
        <Effects />
      </section>
      <section className="column tables-column">
        <Tables />
      </section>
    </div>
  );
}

// --- Rooms ----------------------------------------------------------------------------

function Rooms() {
  const all = useQuery(rooms.all());
  const open = useOp(openRoom);
  const sorted = useMemo(() => [...all].sort((a, b) => a.openedAt - b.openedAt), [all]);
  const loading = all.filter((r) => r.status === "loading").length;

  return (
    <>
      <header className="column-header">
        <h1>Chatrooms</h1>
        <span className="muted">
          {all.length} open{loading > 0 && ` · ${loading} loading`}
        </span>
        <button
          type="button"
          className="primary"
          onClick={() => {
            const taken = new Set(all.map((r) => r.name));
            const free = ROOM_NAMES.filter((n) => !taken.has(`#${n}`));
            const name = free.length > 0 ? pick(free) : `room-${all.length + 1}`;
            open({ name: `#${name}` });
          }}
        >
          + Open room
        </button>
      </header>
      {sorted.length === 0 ? (
        <p className="empty">No rooms open. Open one to start chatting.</p>
      ) : (
        <div className="room-grid">
          {sorted.map((room) => (
            <RoomCard key={room.id} roomId={room.id} />
          ))}
        </div>
      )}
    </>
  );
}

function RoomCard({ roomId }: { roomId: string }) {
  const room = useQuery(rooms.get(roomId));
  const stats = useQuery(roomStats.get(roomId));
  const close = useOp(closeRoom);
  if (room === undefined) return null;

  return (
    <article className="room">
      <header className="room-header">
        <h2>{room.name}</h2>
        {room.status === "ready" && stats !== undefined && (
          <span className="muted">
            {stats.messages} msgs{stats.inFlight > 0 && ` · ${stats.inFlight} in flight`}
          </span>
        )}
        <button
          type="button"
          className="icon"
          aria-label={`Close ${room.name}`}
          onClick={() => close({ roomId })}
        >
          ×
        </button>
      </header>
      {room.status === "loading" ? (
        <div className="room-loading">
          <div className="spinner" />
          <span>Loading history…</span>
          <div className="progress">
            <div />
          </div>
        </div>
      ) : (
        <>
          <MessageList roomId={roomId} />
          <Composer roomId={roomId} />
        </>
      )}
    </article>
  );
}

const STATUS_LABEL = {
  sending: "◷",
  sent: "✓",
  delivered: "✓✓",
  failed: "⚠ not sent",
  received: "",
} as const;

function MessageList({ roomId }: { roomId: string }) {
  const rows = useQuery(messages.byRoom.roomIdEq(roomId));
  // Chronological, except failed sends, which stay at the bottom until retried.
  const sorted = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          Number(a.status === "failed") - Number(b.status === "failed") || a.sentAt - b.sentAt,
      ),
    [rows],
  );
  const listRef = useRef<HTMLOListElement>(null);
  const retry = useOp(retrySend);

  // Keep the newest message in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever the list grows.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sorted.length]);

  return (
    <ol className="messages" ref={listRef}>
      {sorted.map((m) => {
        const mine = m.author === ME;
        return (
          <li key={m.id} className={`message${mine ? " mine" : ""} message-${m.status}`}>
            {!mine && <span className="author">{m.author}</span>}
            <span className="body">{m.body}</span>
            <span className="meta">
              {formatTime(m.sentAt)}
              {mine && (
                <span className={`status status-${m.status}`} title={m.status}>
                  {STATUS_LABEL[m.status]}
                </span>
              )}
              {m.status === "failed" && (
                <button type="button" className="retry" onClick={() => retry({ id: m.id })}>
                  Retry
                </button>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Composer({ roomId }: { roomId: string }) {
  const [body, setBody] = useState("");
  const send = useOp(sendMessage);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (text === "") return;
    send({ roomId, body: text });
    setBody("");
  };
  return (
    <form className="composer" onSubmit={submit}>
      <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Message…" />
      <button type="submit" disabled={body.trim() === ""}>
        Send
      </button>
    </form>
  );
}

// --- Effects --------------------------------------------------------------------------

function Effects() {
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

/** Results come back in unspecified order, so each table picks a display order. */
const SORTS: Record<string, (a: AnyRow, b: AnyRow) => number> = {
  "chat.rooms": (a, b) => (a.openedAt as number) - (b.openedAt as number),
  "chat.messages": (a, b) => (b.sentAt as number) - (a.sentAt as number),
};

function Tables() {
  const tables = useQuery(sys.tables.all());
  return (
    <>
      <header className="column-header">
        <h1>Tables</h1>
        <span className="muted">sys.tables · changed rows flash</span>
      </header>
      {tables.map((t) => (
        <TableCard key={t.name} info={t} />
      ))}
    </>
  );
}

function TableCard({ info }: { info: TableRow }) {
  const rows = useQuery(info.table.all());
  const sorted = useMemo(() => {
    const byKey = (a: AnyRow, b: AnyRow) => String(a[info.key]).localeCompare(String(b[info.key]));
    return [...rows].sort(SORTS[info.name] ?? byKey);
  }, [rows, info]);
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
