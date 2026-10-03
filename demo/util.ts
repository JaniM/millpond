import type { TaskContext } from "../src/index";

/** Resolves after `ms`, or rejects with the signal's reason when it aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * Sleeps, noting the wait on the task's `sys.tasks` row. The inspector's
 * effects panel reads the trailing duration to draw a progress bar.
 */
export async function wait({ note, signal }: TaskContext, what: string, ms: number): Promise<void> {
  note(`${what} · ${(ms / 1000).toFixed(1)}s`);
  await sleep(ms, signal);
  note(null);
}

/** A random integer in [min, max]. */
export function randomBetween(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

export function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
