//#region src/internal.ts
/** Hidden slot holding a definition's runtime data. */
const INTERNAL = Symbol("millpond.internal");
function internalOf(value, what) {
	const data = value !== null && typeof value === "object" ? value[INTERNAL] : void 0;
	if (data === void 0) throw new TypeError(`millpond: expected a ${what}.`);
	return data;
}
function rank(v) {
	if (v === null || v === void 0) return 0;
	switch (typeof v) {
		case "boolean": return 1;
		case "number": return 2;
		case "string": return 3;
		default: return 4;
	}
}
/** Total order over indexable values: nulls, booleans, numbers, strings. */
function compareValues(a, b) {
	const ra = rank(a);
	const rb = rank(b);
	if (ra !== rb) return ra - rb;
	if (ra === 0 || a === b) return 0;
	return a < b ? -1 : a > b ? 1 : 0;
}
/** Whether `row` satisfies the query's prefix equalities and range. */
function matchesQuery(q, row) {
	for (let i = 0; i < q.prefix.length; i++) if (compareValues(row[q.cols[i]], q.prefix[i]) !== 0) return false;
	return q.range === void 0 || inRange(q.range, row[q.cols[q.prefix.length]]);
}
function inRange(r, v) {
	if (r.hasLo) {
		const c = compareValues(v, r.lo);
		if (c < 0 || c === 0 && !r.loInc) return false;
	}
	if (r.hasHi) {
		const c = compareValues(v, r.hi);
		if (c > 0 || c === 0 && !r.hiInc) return false;
	}
	return true;
}
/** Structural equality, used to detect schemas whose output differs from input. */
function deepEqual(a, b) {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	for (const k of ka) {
		if (!Object.hasOwn(b, k)) return false;
		if (!deepEqual(a[k], b[k])) return false;
	}
	return true;
}
/** Equal query results: the same value, or arrays of the same rows in order. */
function sameResult(a, b) {
	if (Object.is(a, b)) return true;
	if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
/** Same keys with `Object.is`-equal values. */
function shallowEqual(a, b) {
	const ka = Object.keys(a);
	if (ka.length !== Object.keys(b).length) return false;
	for (const k of ka) if (!Object.hasOwn(b, k) || !Object.is(a[k], b[k])) return false;
	return true;
}
function isThenable(v) {
	return v !== null && (typeof v === "object" || typeof v === "function") && typeof v.then === "function";
}
function isAbortError(e) {
	return typeof e === "object" && e !== null && e.name === "AbortError";
}
function abortError() {
	if (typeof DOMException === "function") return new DOMException("millpond: the task was aborted.", "AbortError");
	const err = /* @__PURE__ */ new Error("millpond: the task was aborted.");
	err.name = "AbortError";
	return err;
}
//#endregion
Object.defineProperty(exports, "INTERNAL", {
	enumerable: true,
	get: function() {
		return INTERNAL;
	}
});
Object.defineProperty(exports, "abortError", {
	enumerable: true,
	get: function() {
		return abortError;
	}
});
Object.defineProperty(exports, "compareValues", {
	enumerable: true,
	get: function() {
		return compareValues;
	}
});
Object.defineProperty(exports, "deepEqual", {
	enumerable: true,
	get: function() {
		return deepEqual;
	}
});
Object.defineProperty(exports, "inRange", {
	enumerable: true,
	get: function() {
		return inRange;
	}
});
Object.defineProperty(exports, "internalOf", {
	enumerable: true,
	get: function() {
		return internalOf;
	}
});
Object.defineProperty(exports, "isAbortError", {
	enumerable: true,
	get: function() {
		return isAbortError;
	}
});
Object.defineProperty(exports, "isThenable", {
	enumerable: true,
	get: function() {
		return isThenable;
	}
});
Object.defineProperty(exports, "matchesQuery", {
	enumerable: true,
	get: function() {
		return matchesQuery;
	}
});
Object.defineProperty(exports, "sameResult", {
	enumerable: true,
	get: function() {
		return sameResult;
	}
});
Object.defineProperty(exports, "shallowEqual", {
	enumerable: true,
	get: function() {
		return shallowEqual;
	}
});

//# sourceMappingURL=internal-_PFynI32.cjs.map