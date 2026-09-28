import { createContext, type ReactNode, useContext } from "react";
import type { AnyDb, OpFn } from "./db";
import { notImplemented } from "./internal";
import type { Op } from "./op";
import type { Query } from "./query";

const DbContext = createContext<AnyDb | null>(null);

/** Provides the db to the tree. Place once at the root. */
export function DbProvider({ db, children }: { db: AnyDb; children: ReactNode }) {
  return <DbContext.Provider value={db}>{children}</DbContext.Provider>;
}

/** Returns the db from context, throwing if there is no provider. */
export function useDb(): AnyDb {
  const db = useContext(DbContext);
  if (db === null) {
    throw new Error("reactive-db: useDb must be used within a <DbProvider>.");
  }
  return db;
}

/**
 * Subscribes to a query and re-renders when its result changes. Built on
 * `useSyncExternalStore`; equal queries share a subscription, so rebuilding
 * the query every render is free.
 */
export function useQuery<Row, Result>(query: Query<Row, Result>): Result {
  void query;
  return notImplemented("useQuery()");
}

/** Returns a function, bound to the provider's db, that runs the op. */
export function useOp<Args>(op: Op<Args>): OpFn<Args> {
  void op;
  return notImplemented("useOp()");
}
