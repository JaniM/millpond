import { type FormEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useOp, useQuery } from "../src/react";
import { closeRoom, ME, messages, openRoom, retrySend, roomStats, rooms, sendMessage } from "./db";
import { Effects, type Sorts, Tables } from "./inspector";
import { formatTime, pick } from "./util";

const SORTS: Sorts = {
  "chat.rooms": (a, b) => (a.openedAt as number) - (b.openedAt as number),
  "chat.messages": (a, b) => (b.sentAt as number) - (a.sentAt as number),
};

const ROOM_NAMES = ["general", "random", "design", "engineering", "support", "releases", "ops"];

export function App() {
  return (
    <div className="layout">
      <section className="column main-column">
        <Rooms />
      </section>
      <section className="column effects-column">
        <Effects />
      </section>
      <section className="column tables-column">
        <Tables sorts={SORTS} />
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
        <a className="muted nav" href="game/">
          idle game demo →
        </a>
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
