import { H as Query, a as OpFn, t as AnyDb, y as Op } from "./db-DJXBIulF.cjs";
import { ReactNode } from "react";
//#region src/react.d.ts
/** Provides the db to the tree. Place once at the root. */
export declare function DbProvider({ db, children }: {
  db: AnyDb;
  children: ReactNode;
}): import("react").JSX.Element;
/** Returns the db from context, throwing if there is no provider. */
export declare function useDb(): AnyDb;
/**
 * Subscribes to a query and re-renders when its result changes. Built on
 * `useSyncExternalStore`; equal queries share a subscription, so rebuilding
 * the query every render is free.
 */
export declare function useQuery<Row, Result>(query: Query<Row, Result>): Result;
/** Returns a function, bound to the provider's db, that runs the op. */
export declare function useOp<Args>(op: Op<Args>): OpFn<Args>;
//#endregion
//# sourceMappingURL=react.d.cts.map