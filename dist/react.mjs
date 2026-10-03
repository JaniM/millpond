import { o as internalOf, u as sameResult } from "./internal-CxxL5Fz9.mjs";
import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from "react";
import { jsx } from "react/jsx-runtime";
//#region src/react.tsx
const DbContext = createContext(null);
/** Provides the db to the tree. Place once at the root. */
function DbProvider({ db, children }) {
	return /* @__PURE__ */ jsx(DbContext.Provider, {
		value: db,
		children
	});
}
/** Returns the db from context, throwing if there is no provider. */
function useDb() {
	const db = useContext(DbContext);
	if (db === null) throw new Error("millpond: useDb must be used within a <DbProvider>.");
	return db;
}
/**
* Subscribes to a query and re-renders when its result changes. Built on
* `useSyncExternalStore`; equal queries share a subscription, so rebuilding
* the query every render is free.
*/
function useQuery(query) {
	const db = useDb();
	const key = internalOf(query, "query").key;
	const subscribe = useCallback((onChange) => db.subscribe(query, onChange), [db, key]);
	const snapshot = useRef(null);
	const getSnapshot = () => {
		const value = db.read(query);
		const last = snapshot.current;
		if (last !== null && last.db === db && last.key === key && sameResult(last.value, value)) return last.value;
		snapshot.current = {
			db,
			key,
			value
		};
		return value;
	};
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
/** Returns a function, bound to the provider's db, that runs the op. */
function useOp(op) {
	const db = useDb();
	return useCallback((args) => db.run(op, args), [db, op]);
}
//#endregion
export { DbProvider, useDb, useOp, useQuery };

//# sourceMappingURL=react.mjs.map