import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useRef,
  useSyncExternalStore,
} from "react";
import type { AnyDb, OpFn } from "./db";
import { internalOf, type QueryInfo, sameResult } from "./internal";
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
  const db = useDb();
  // Equal queries share a key, so a query rebuilt every render keeps the same
  // subscription.
  const key = internalOf<QueryInfo>(query, "query").key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` identifies the query structurally.
  const subscribe = useCallback((onChange: () => void) => db.subscribe(query, onChange), [db, key]);
  // Once subscribed, the db caches the result and keeps its identity. Before
  // that (the first render), reads are fresh, so hold on to the last snapshot
  // while it is unchanged — useSyncExternalStore requires a stable value.
  const snapshot = useRef<{ db: AnyDb; key: string; value: Result } | null>(null);
  const getSnapshot = () => {
    const value = db.read(query);
    const last = snapshot.current;
    if (last !== null && last.db === db && last.key === key && sameResult(last.value, value)) {
      return last.value;
    }
    snapshot.current = { db, key, value };
    return value;
  };
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Returns a function, bound to the provider's db, that runs the op. */
export function useOp<Args>(op: Op<Args>): OpFn<Args> {
  const db = useDb();
  return useCallback((args?: Args) => db.run(op, args as Args), [db, op]) as OpFn<Args>;
}
