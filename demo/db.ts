import { z } from "zod";
import {
  aggregate,
  count,
  createDb,
  effect,
  feature,
  max,
  op,
  sum,
  type TaskContext,
  table,
} from "../src/index";
import { pick, randomBetween, sleep } from "./util";

const id = () => crypto.randomUUID().slice(0, 8);

// --- Tables ---------------------------------------------------------------------------

export const rooms = table(
  z.object({
    id: z.string(),
    name: z.string(),
    status: z.enum(["loading", "ready"]),
    openedAt: z.number(),
  }),
  { key: "id", generate: id, indexes: { byStatus: ["status"] } },
);

export const messages = table(
  z.object({
    id: z.string(),
    roomId: z.string(),
    author: z.string(),
    body: z.string(),
    sentAt: z.number(),
    // Outgoing messages move sending → sent → delivered, or sending → failed;
    // incoming ones are "received".
    status: z.enum(["sending", "sent", "delivered", "failed", "received"]),
  }),
  {
    key: "id",
    generate: id,
    indexes: { byRoom: ["roomId", "sentAt"], byStatus: ["status"] },
  },
);

/** Every error reported to the db's `onError`. */
export const errors = table(
  z.object({
    id: z.string(),
    /** Where it happened: a registered name plus the scope or task path. */
    source: z.string(),
    message: z.string(),
    occurredAt: z.number(),
  }),
  { key: "id", generate: id },
);

export const roomStats = aggregate({
  table: table(
    z.object({
      roomId: z.string(),
      messages: z.number(),
      inFlight: z.number(),
      lastMessageAt: z.number().nullable(),
    }),
    { key: "roomId" },
  ),
  inputs: [rooms, messages],
  compute: (q, emit) =>
    q.each(rooms.all(), (room) => {
      const inRoom = messages.byRoom.roomIdEq(room.id);
      emit({
        roomId: room.id,
        messages: q.reduce(inRoom, count),
        inFlight: q.reduce(
          inRoom,
          (m) => (m.status === "sending" || m.status === "sent" ? 1 : 0),
          sum,
        ),
        lastMessageAt: q.reduce(inRoom, (m) => m.sentAt, max) ?? null,
      });
    }),
});

// --- Ops ------------------------------------------------------------------------------

export const ME = "you";

export const openRoom = op((tx, { name }: { name: string }) => {
  tx.insert(rooms, { name, status: "loading", openedAt: Date.now() });
});

type Incoming = { author: string; body: string; sentAt: number };

export const roomLoaded = op((tx, a: { roomId: string; history: Incoming[] }) => {
  tx.update(rooms, a.roomId, { status: "ready" });
  for (const m of a.history) tx.insert(messages, { ...m, roomId: a.roomId, status: "received" });
});

export const closeRoom = op((tx, { roomId }: { roomId: string }) => {
  for (const m of tx.read(messages.byRoom.roomIdEq(roomId))) tx.delete(messages, m.id);
  tx.delete(rooms, roomId);
});

export const receiveMessage = op((tx, a: { roomId: string; author: string; body: string }) => {
  tx.insert(messages, { ...a, sentAt: Date.now(), status: "received" });
});

export const sendMessage = op((tx, a: { roomId: string; body: string }) => {
  tx.insert(messages, { ...a, author: ME, sentAt: Date.now(), status: "sending" });
});

export const messageSent = op((tx, { id }: { id: string }) => {
  tx.update(messages, id, { status: "sent" });
});

export const messageDelivered = op((tx, { id }: { id: string }) => {
  tx.update(messages, id, { status: "delivered" });
});

export const sendFailed = op((tx, { id }: { id: string }) => {
  tx.update(messages, id, { status: "failed" });
});

/**
 * Resends a failed message as if it were new: it gets a fresh timestamp and
 * re-enters the "sending" query, which starts a new send task.
 */
export const retrySend = op((tx, { id }: { id: string }) => {
  tx.update(messages, id, { status: "sending", sentAt: Date.now() });
});

export const recordError = op((tx, e: { source: string; message: string }) => {
  tx.insert(errors, { ...e, occurredAt: Date.now() });
});

// --- Effects --------------------------------------------------------------------------

const PEOPLE = ["Ada", "Grace", "Linus", "Margaret", "Alan", "Barbara", "Ken", "Radia"];
const LINES = [
  "Anyone around?",
  "Just pushed a fix, can someone take a look?",
  "Lunch in 10?",
  "The build is green again 🎉",
  "I'll be a few minutes late to standup.",
  "Has anyone seen the new design mocks?",
  "Coffee machine is broken. Again.",
  "Shipping it!",
  "Can we move the sync to tomorrow?",
  "TIL you can subscribe to an index prefix.",
  "brb",
  "Nice work on the release notes.",
];

const incoming = (): { author: string; body: string } => ({
  author: pick(PEOPLE),
  body: pick(LINES),
});

/**
 * Sleeps, noting the wait on the task's `sys.tasks` row. The effects panel
 * reads the trailing duration to draw a progress bar.
 */
async function wait({ note, signal }: TaskContext, what: string, ms: number): Promise<void> {
  note(`${what} · ${(ms / 1000).toFixed(1)}s`);
  await sleep(ms, signal);
  note(null);
}

/** Simulates fetching a room's recent history, which takes two seconds. */
export const loadRoom = effect({
  inputs: [rooms],
  watch: (q, task) =>
    q.each(rooms.byStatus.statusEq("loading"), (room) =>
      task(
        async (ctx) => {
          await wait(ctx, "fetching history", 2000);
          const now = Date.now();
          const n = randomBetween(1, 3);
          const history = Array.from({ length: n }, (_, i) => ({
            ...incoming(),
            sentAt: now - (n - i) * randomBetween(30_000, 90_000),
          }));
          ctx.run(roomLoaded, { roomId: room.id, history });
        },
        { label: room.name },
      ),
    ),
});

/** Every 5–20 seconds, someone says something in each open room. */
export const chatter = effect({
  inputs: [rooms],
  watch: (q, task) =>
    q.each(
      rooms.byStatus.statusEq("ready"),
      (room) =>
        task(
          async (ctx) => {
            for (;;) {
              await wait(ctx, "next message", randomBetween(5_000, 20_000));
              ctx.run(receiveMessage, { roomId: room.id, ...incoming() });
            }
          },
          { label: room.name },
        ),
      // Only leaving the "ready" query (closing the room) stops the loop.
      { rerunOn: [] },
    ),
});

/** Half of all sends fail. */
const SEND_FAILURE_RATE = 0.5;

/**
 * Simulates the network: a sent message is acknowledged, then delivered. A
 * failed send marks the message failed, then rethrows, so the task shows as
 * failed in sys.tasks and the error reaches onError.
 */
export const delivery = effect({
  inputs: [messages],
  watch: (q, task) => {
    q.each(messages.byStatus.statusEq("sending"), (m) =>
      task(
        async (ctx) => {
          await wait(ctx, "sending", randomBetween(300, 1_200));
          if (Math.random() < SEND_FAILURE_RATE) {
            ctx.run(sendFailed, { id: m.id });
            throw new Error(`network error: “${m.body}” was not sent`);
          }
          ctx.run(messageSent, { id: m.id });
        },
        { label: `send “${m.body}”` },
      ),
    );
    q.each(messages.byStatus.statusEq("sent"), (m) =>
      task(
        async (ctx) => {
          await wait(ctx, "delivering", randomBetween(1_000, 3_000));
          ctx.run(messageDelivered, { id: m.id });
        },
        { label: `deliver “${m.body}”` },
      ),
    );
  },
});

// --- Assembly -------------------------------------------------------------------------

export const chat = feature({
  tables: { rooms, messages, roomStats },
  ops: {
    openRoom,
    roomLoaded,
    closeRoom,
    receiveMessage,
    sendMessage,
    messageSent,
    messageDelivered,
    sendFailed,
    retrySend,
  },
  effects: { loadRoom, chatter, delivery },
});

export const logs = feature({ tables: { errors }, ops: { recordError } });

export const db = createDb({
  features: { chat, logs },
  // Maintains the sys.* tables the right-hand column shows.
  introspect: { history: 4 },
  // Runs after the flush, so it may call ops: every error becomes a row.
  onError: (err, { db, source }) => {
    const message = err instanceof Error ? err.message : String(err);
    db.run(recordError, { source, message });
  },
});
