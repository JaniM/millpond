import type { ScopeApi } from "./aggregate";
import type { ReadonlyDb } from "./db";
import { notImplemented } from "./internal";
import type { Op } from "./op";
import type { RowOf, Table } from "./table";

/** The context a task runs in. It writes back only through `run`. */
export interface TaskContext {
  /** A read-only view of the latest committed state. */
  db: ReadonlyDb;
  /** The only way to write from a task. */
  run<Args>(op: Op<Args>, args: Args, options?: { ignoreAbort?: boolean }): void;
  /** Fires when the task is aborted. */
  signal: AbortSignal;
}

/**
 * Registers the async task for the current scope. Called inside a `watch`
 * scope (`q.each`/`q.reduce`), so `rerunOn` and abort/restart are governed by
 * that scope, not by `task` itself.
 */
export type Task = (fn: (ctx: TaskContext) => void | Promise<void>) => void;

export interface EffectConfig<Inputs extends readonly Table[]> {
  /** Every table and aggregate `watch` may read. */
  inputs: Inputs;
  /** Builds scopes restricted to the declared inputs; one task per scope. */
  watch: (q: ScopeApi<RowOf<Inputs[number]>>, task: Task) => void;
}

/** An effect runs one async task per scope, usually one per row of a query. */
export interface Effect {
  readonly kind: "effect";
}

export function effect<const Inputs extends readonly Table[]>(
  config: EffectConfig<Inputs>,
): Effect {
  void config;
  return notImplemented("effect()");
}
