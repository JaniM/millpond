import type { Feature } from "./feature";
import { notImplemented } from "./internal";
import type { Op } from "./op";
import type { Query } from "./query";

/** A read-only view of the db, as seen from tasks and outside code. */
export interface ReadonlyDb {
  /** One-shot read of a query against the latest committed state. */
  read<Row, Result>(query: Query<Row, Result>): Result;
}

/** Unsubscribe handle returned by `subscribe`. */
export type Unsubscribe = () => void;

/**
 * A db handle without the compile-time `ops` tree. Every `Db<Features>` is
 * assignable to it, so it is the type to use where the feature set is not
 * known statically — a provider, a context, or a shared reference. (A concrete
 * `Db<Features>` is not assignable to another `Db` with different features,
 * because op argument types are contravariant.)
 */
export interface AnyDb {
  read<Row, Result>(query: Query<Row, Result>): Result;
  subscribe<Row, Result>(
    query: Query<Row, Result>,
    listener: (result: Result) => void,
  ): Unsubscribe;
  run<Args>(op: Op<Args>, args: Args): void;
  dispose(): void;
}

/** A bound op call: `(args) => void`, or `() => void` for an `Op<void>`. */
// biome-ignore lint/suspicious/noConfusingVoidType: the `[void]` tuple is an exact-void check that distinguishes argument-free ops.
export type OpFn<Args> = [Args] extends [void] ? () => void : (args: Args) => void;

/** The `db.ops.<feature>.<op>(args)` convenience tree, typed from the features. */
export type OpsTree<Features extends Record<string, Feature>> = {
  [F in keyof Features]: Features[F] extends Feature<infer _Tables, infer Ops, infer _Effects>
    ? { [K in keyof Ops]: Ops[K] extends Op<infer Args> ? OpFn<Args> : never }
    : never;
};

/** Passed to `onError`; `source` is the registered name of what failed. */
export interface ErrorInfo<Features extends Record<string, Feature> = Record<string, Feature>> {
  db: Db<Features>;
  source: string;
}

export interface CreateDbOptions<Features extends Record<string, Feature>> {
  features: Features;
  /** Validate every write against its schema. On by default. */
  validate?: boolean;
  /** Shallow-freeze every stored row. On by default. */
  freeze?: boolean;
  /** Runs after the flush; may call ops, e.g. to record the error. */
  onError?: (err: unknown, info: ErrorInfo<Features>) => void;
}

export interface Db<Features extends Record<string, Feature> = Record<string, Feature>>
  extends AnyDb {
  /** The `db.ops.<feature>.<op>()` convenience tree. */
  ops: OpsTree<Features>;
}

export function createDb<const Features extends Record<string, Feature>>(
  options: CreateDbOptions<Features>,
): Db<Features> {
  void options;
  return notImplemented("createDb()");
}
