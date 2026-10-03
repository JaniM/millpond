Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const require_internal = require("./internal-_PFynI32.cjs");
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
//#region src/react.tsx
const DbContext = (0, react.createContext)(null);
/** Provides the db to the tree. Place once at the root. */
function DbProvider({ db, children }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DbContext.Provider, {
		value: db,
		children
	});
}
/** Returns the db from context, throwing if there is no provider. */
function useDb() {
	const db = (0, react.useContext)(DbContext);
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
	const key = require_internal.internalOf(query, "query").key;
	const subscribe = (0, react.useCallback)((onChange) => db.subscribe(query, onChange), [db, key]);
	const snapshot = (0, react.useRef)(null);
	const getSnapshot = () => {
		const value = db.read(query);
		const last = snapshot.current;
		if (last !== null && last.db === db && last.key === key && require_internal.sameResult(last.value, value)) return last.value;
		snapshot.current = {
			db,
			key,
			value
		};
		return value;
	};
	return (0, react.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
}
/** Returns a function, bound to the provider's db, that runs the op. */
function useOp(op) {
	const db = useDb();
	return (0, react.useCallback)((args) => db.run(op, args), [db, op]);
}
//#endregion
exports.DbProvider = DbProvider;
exports.useDb = useDb;
exports.useOp = useOp;
exports.useQuery = useQuery;

//# sourceMappingURL=react.cjs.map