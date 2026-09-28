// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AnyDb } from "../../src/index";
import { DbProvider, useOp, useQuery } from "../../src/react";
import { type ChatWorld, chatWorld, spec } from "./harness";

// Spec §"Lifecycle and React bindings → React".

afterEach(cleanup);

function ThreadView({
  w,
  label = "send",
  onRender,
}: {
  w: ChatWorld;
  label?: string;
  onRender?: () => void;
}) {
  onRender?.();
  // Rebuilt on every render on purpose: equal queries must be free.
  const rows = useQuery(w.tables.messages.byThread.threadIdEq("t1"));
  const send = useOp(w.ops.send);
  return (
    <div>
      <span data-testid={`${label}-count`}>{rows.length}</span>
      <button
        type="button"
        onClick={() =>
          send({ id: `m${rows.length + 1}`, threadId: "t1", body: "hi", sentAt: rows.length })
        }
      >
        {label}
      </button>
    </div>
  );
}

function withThread(w: ChatWorld): AnyDb {
  const db = w.create();
  db.run(w.ops.createThread, { id: "t1", title: "one" });
  return db;
}

spec("React bindings", () => {
  it("useQuery renders the current result and re-renders when an op changes it", async () => {
    const w = chatWorld();
    const db = withThread(w);

    render(
      <DbProvider db={db}>
        <ThreadView w={w} />
      </DbProvider>,
    );
    expect(screen.getByTestId("send-count").textContent).toBe("0");

    await act(async () => {
      screen.getByText("send").click();
    });
    expect(screen.getByTestId("send-count").textContent).toBe("1");
  });

  it("does not re-render for changes outside the query, though the query is rebuilt each render", async () => {
    const w = chatWorld();
    const db = withThread(w);
    db.run(w.ops.createThread, { id: "t2", title: "two" });
    const onRender = vi.fn();
    render(
      <DbProvider db={db}>
        <ThreadView w={w} onRender={onRender} />
      </DbProvider>,
    );
    const rendersAfterMount = onRender.mock.calls.length;

    await act(async () => {
      db.run(w.ops.postMessage, { id: "n1", threadId: "t2", body: "x", sentAt: 1 });
    });
    expect(onRender).toHaveBeenCalledTimes(rendersAfterMount);
  });

  it("useOp is bound to the nearest provider's db (no need to import the db)", async () => {
    const w = chatWorld();
    const left = withThread(w);
    const right = withThread(w);
    render(
      <>
        <DbProvider db={left}>
          <ThreadView w={w} label="left" />
        </DbProvider>
        <DbProvider db={right}>
          <ThreadView w={w} label="right" />
        </DbProvider>
      </>,
    );
    await act(async () => {
      screen.getByText("left").click();
    });
    // The op ran against the left provider's db only.
    expect(left.read(w.tables.messages.byThread.threadIdEq("t1"))).toHaveLength(1);
    expect(right.read(w.tables.messages.byThread.threadIdEq("t1"))).toHaveLength(0);
    expect(screen.getByTestId("right-count").textContent).toBe("0");
  });

  it("unsubscribes when the component unmounts", async () => {
    const w = chatWorld();
    const db = withThread(w);
    // Count live subscriptions; the bindings are built on `subscribe` (spec §React).
    let active = 0;
    const subscribe = db.subscribe.bind(db);
    db.subscribe = (query, listener) => {
      active++;
      const stop = subscribe(query, listener);
      return () => {
        active--;
        stop();
      };
    };
    const { unmount } = render(
      <DbProvider db={db}>
        <ThreadView w={w} />
      </DbProvider>,
    );
    expect(active).toBeGreaterThan(0);
    unmount();
    expect(active).toBe(0);
  });

  it("throws when a hook is used outside a DbProvider", () => {
    const w = chatWorld();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => render(<ThreadView w={w} />)).toThrow(/DbProvider/);
    } finally {
      consoleError.mockRestore();
    }
  });
});
