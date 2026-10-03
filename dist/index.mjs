import { a as inRange, c as isThenable, d as shallowEqual, i as deepEqual, l as matchesQuery, n as abortError, o as internalOf, r as compareValues, s as isAbortError, t as INTERNAL, u as sameResult } from "./internal-CxxL5Fz9.mjs";
//#region src/aggregate.ts
function aggregate(config) {
	const def = internalOf(config.table, "table");
	if (def.aggregate !== void 0) throw new Error("millpond: this table is already the output of another aggregate.");
	for (const input of config.inputs) internalOf(input, "table or aggregate as input");
	def.aggregate = {
		inputs: [...config.inputs],
		compute: config.compute
	};
	return config.table;
}
//#endregion
//#region src/table.ts
function table(schema, options) {
	if (typeof schema?.["~standard"]?.validate !== "function") throw new TypeError("millpond: table() expects a Standard Schema.");
	if (typeof options?.key !== "string") throw new TypeError("millpond: table() expects a `key` option naming the primary key.");
	const indexes = /* @__PURE__ */ new Map([["$pk", [options.key]]]);
	for (const [name, cols] of Object.entries(options.indexes ?? {})) {
		if (name === "all" || name === "get" || name === "$pk") throw new Error(`millpond: "${name}" is reserved and cannot name an index.`);
		indexes.set(name, [...cols]);
	}
	const def = {
		id: nextTableId++,
		schema,
		key: options.key,
		generate: options.generate,
		indexes,
		aggregate: void 0
	};
	const surface = {
		kind: "table",
		[INTERNAL]: def,
		all: () => makeQuery(def, "$pk", [], void 0, false),
		get: (key) => makeQuery(def, "$pk", [key], void 0, true)
	};
	for (const name of indexes.keys()) if (name !== "$pk") surface[name] = makeStep(def, name, []);
	return surface;
}
let nextTableId = 1;
function makeQuery(def, index, prefix, range, single) {
	const info = {
		table: def,
		index,
		cols: def.indexes.get(index) ?? [],
		prefix,
		range,
		single,
		key: JSON.stringify([
			def.id,
			index,
			single,
			prefix.map(encode),
			range && [
				range.hasLo,
				encode(range.lo),
				range.loInc,
				range.hasHi,
				encode(range.hi),
				range.hiInc
			]
		])
	};
	return {
		kind: "query",
		[INTERNAL]: info
	};
}
/** Encodes a value so that values of different types never collide. */
function encode(v) {
	return v === void 0 ? ["u"] : typeof v === "number" ? ["n", String(v)] : v;
}
/** A step before `prefix.length`'s column: `<col>Eq` plus the comparisons. */
function makeStep(def, index, prefix) {
	const q = makeQuery(def, index, prefix, void 0, false);
	const col = (def.indexes.get(index) ?? [])[prefix.length];
	if (col === void 0) return q;
	q[`${col}Eq`] = (v) => makeStep(def, index, [...prefix, v]);
	const bound = (r) => makeRange(def, index, prefix, col, {
		...NO_RANGE,
		...r
	});
	q[`${col}Gt`] = (v) => bound({
		hasLo: true,
		lo: v,
		loInc: false
	});
	q[`${col}Gte`] = (v) => bound({
		hasLo: true,
		lo: v,
		loInc: true
	});
	q[`${col}Lt`] = (v) => bound({
		hasHi: true,
		hi: v,
		hiInc: false
	});
	q[`${col}Lte`] = (v) => bound({
		hasHi: true,
		hi: v,
		hiInc: true
	});
	return q;
}
const NO_RANGE = {
	hasLo: false,
	loInc: false,
	hasHi: false,
	hiInc: false
};
/** A range query; the complementary bound may still be added once. */
function makeRange(def, index, prefix, col, range) {
	const q = makeQuery(def, index, prefix, range, false);
	if (!range.hasHi) {
		q[`${col}Lt`] = (v) => makeRange(def, index, prefix, col, {
			...range,
			hasHi: true,
			hi: v,
			hiInc: false
		});
		q[`${col}Lte`] = (v) => makeRange(def, index, prefix, col, {
			...range,
			hasHi: true,
			hi: v,
			hiInc: true
		});
	}
	if (!range.hasLo) {
		q[`${col}Gt`] = (v) => makeRange(def, index, prefix, col, {
			...range,
			hasLo: true,
			lo: v,
			loInc: false
		});
		q[`${col}Gte`] = (v) => makeRange(def, index, prefix, col, {
			...range,
			hasLo: true,
			lo: v,
			loInc: true
		});
	}
	return q;
}
//#endregion
//#region src/sys.ts
/** Engine-written rows aren't validated; the schema only carries the type. */
function trusted() {
	return { "~standard": {
		version: 1,
		vendor: "millpond",
		validate: (value) => ({ value })
	} };
}
/** The built-in system tables. Reading them requires `createDb({ introspect })`. */
const sys = {
	tasks: table(trusted(), {
		key: "id",
		indexes: {
			byEffect: ["effect", "status"],
			byStatus: ["status"]
		}
	}),
	effects: table(trusted(), { key: "name" }),
	tables: table(trusted(), {
		key: "name",
		indexes: { byKind: ["kind"] }
	})
};
/** Each system table's definition and its name. */
const SYS_NAMES = new Map(Object.entries(sys).map(([key, t]) => [internalOf(t, "table"), `sys.${key}`]));
//#endregion
//#region src/introspect.ts
/** Maintains one db's system tables. */
var Introspection = class {
	host;
	history;
	nextId = 1;
	tasks;
	effects;
	/** Finished task ids per effect, oldest first. */
	finished = /* @__PURE__ */ new Map();
	constructor(host, history) {
		this.host = host;
		this.history = history;
		this.tasks = host.stateOf(internalOf(sys.tasks, "table"));
		this.effects = host.stateOf(internalOf(sys.effects, "table"));
	}
	/** Fills `sys.tables` and `sys.effects` when the db is created. */
	init(tables, effects) {
		const tablesState = this.host.stateOf(internalOf(sys.tables, "table"));
		for (const { state, value } of tables) {
			if (SYS_NAMES.has(state.def)) continue;
			const indexes = {};
			for (const [name, cols] of state.def.indexes) if (name !== "$pk") indexes[name] = cols;
			const row = {
				name: state.name,
				kind: state.def.aggregate === void 0 ? "table" : "aggregate",
				key: state.def.key,
				indexes,
				table: value
			};
			this.host.write(tablesState, row.name, row);
		}
		for (const { name, inputs } of effects) {
			const row = {
				name,
				inputs,
				state: "active",
				running: 0,
				started: 0,
				done: 0,
				failed: 0,
				aborted: 0
			};
			this.host.write(this.effects, name, row);
		}
	}
	start(effect, path, label, restartOf) {
		const record = {
			id: this.nextId++,
			effect,
			ended: false
		};
		const row = {
			id: record.id,
			effect,
			path,
			label: label ?? path,
			status: "running",
			abortReason: null,
			restartOf,
			note: null,
			error: null,
			startedAt: Date.now(),
			endedAt: null
		};
		this.host.write(this.tasks, record.id, row);
		this.count(effect, {
			running: 1,
			started: 1
		});
		return record;
	}
	/** Records that the engine aborted a running task; its code may still be running. */
	aborted(record, abortReason) {
		if (!record.ended) this.patchTask(record, { abortReason });
	}
	/** Records how a task's code settled. Only the first call counts. */
	end(record, status, error = null) {
		if (record.ended) return;
		record.ended = true;
		this.patchTask(record, {
			status,
			endedAt: Date.now(),
			error
		});
		this.count(record.effect, {
			running: -1,
			[status]: 1
		});
		let ids = this.finished.get(record.effect);
		if (ids === void 0) {
			ids = [];
			this.finished.set(record.effect, ids);
		}
		ids.push(record.id);
		while (ids.length > this.history) this.host.write(this.tasks, ids.shift(), void 0);
	}
	note(record, note) {
		if (!record.ended) this.patchTask(record, { note });
	}
	disable(effect) {
		this.patch(this.effects, effect, { state: "disabled" });
	}
	patchTask(record, changes) {
		this.patch(this.tasks, record.id, changes);
	}
	count(effect, deltas) {
		const row = this.effects.rows.get(effect);
		if (row === void 0) return;
		const changes = {};
		for (const [k, d] of Object.entries(deltas)) changes[k] = row[k] + d;
		this.patch(this.effects, effect, changes);
	}
	patch(ts, key, changes) {
		const row = ts.rows.get(key);
		if (row !== void 0) this.host.write(ts, key, {
			...row,
			...changes
		});
	}
};
//#endregion
//#region src/store.ts
function compareTuples(a, b) {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const c = compareValues(a[i], b[i]);
		if (c !== 0) return c;
	}
	return a.length - b.length;
}
/**
* One index as a sorted array of entries. Prefix and range scans are a binary
* search plus a walk; writes are a binary search plus a splice.
*/
var SortedIndex = class {
	cols;
	keyField;
	entries = [];
	constructor(cols, keyField) {
		this.cols = cols;
		this.keyField = keyField;
	}
	tupleOf(row) {
		const t = this.cols.map((c) => row[c]);
		t.push(row[this.keyField]);
		return t;
	}
	/** First position whose entry is not `before`. */
	search(before) {
		let lo = 0;
		let hi = this.entries.length;
		while (lo < hi) {
			const mid = lo + hi >>> 1;
			if (before(this.entries[mid])) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}
	insert(row) {
		const tuple = this.tupleOf(row);
		const i = this.search((e) => compareTuples(e.tuple, tuple) < 0);
		this.entries.splice(i, 0, {
			tuple,
			row
		});
	}
	remove(row) {
		const tuple = this.tupleOf(row);
		const i = this.search((e) => compareTuples(e.tuple, tuple) < 0);
		const e = this.entries[i];
		if (e !== void 0 && compareTuples(e.tuple, tuple) === 0) this.entries.splice(i, 1);
	}
	scan(q) {
		const { prefix, range } = q;
		const n = prefix.length;
		const cmpPrefix = (e) => {
			for (let i = 0; i < n; i++) {
				const c = compareValues(e.tuple[i], prefix[i]);
				if (c !== 0) return c;
			}
			return 0;
		};
		const start = this.search((e) => {
			const c = cmpPrefix(e);
			if (c !== 0) return c < 0;
			if (range?.hasLo) {
				const r = compareValues(e.tuple[n], range.lo);
				return r < 0 || r === 0 && !range.loInc;
			}
			return false;
		});
		const out = [];
		for (let i = start; i < this.entries.length; i++) {
			const e = this.entries[i];
			if (cmpPrefix(e) !== 0) break;
			if (range !== void 0 && !inRange(range, e.tuple[n])) {
				if (range.hasHi) break;
				continue;
			}
			out.push(e.row);
		}
		return out;
	}
};
/** One table's rows in one db. */
var TableState = class {
	def;
	name;
	rows = /* @__PURE__ */ new Map();
	indexes = /* @__PURE__ */ new Map();
	constructor(def, name) {
		this.def = def;
		this.name = name;
		for (const [name, cols] of def.indexes) this.indexes.set(name, new SortedIndex(cols, def.key));
	}
	set(key, row) {
		const old = this.rows.get(key);
		for (const idx of this.indexes.values()) {
			if (old !== void 0) idx.remove(old);
			idx.insert(row);
		}
		this.rows.set(key, row);
	}
	delete(key) {
		const old = this.rows.get(key);
		if (old === void 0) return;
		for (const idx of this.indexes.values()) idx.remove(old);
		this.rows.delete(key);
	}
	/** Reads a query against the stored rows (a fresh array, or a row). */
	read(q) {
		if (q.single) return this.rows.get(q.prefix[0]);
		const idx = this.indexes.get(q.index);
		if (idx === void 0) throw new Error(`millpond: unknown index "${q.index}".`);
		return idx.scan(q);
	}
};
const prefixKey = (values) => JSON.stringify(values.map((v) => typeof v === "number" ? ["n", String(v)] : v));
/**
* Watchers registered by query prefix: a changed row finds every affected
* watcher with one hash lookup per prefix length of each watched index.
*/
var Registry = class {
	byTable = /* @__PURE__ */ new Map();
	bucket(q) {
		let indexes = this.byTable.get(q.table);
		if (indexes === void 0) {
			indexes = /* @__PURE__ */ new Map();
			this.byTable.set(q.table, indexes);
		}
		let iw = indexes.get(q.index);
		if (iw === void 0) {
			iw = {
				cols: q.cols,
				byPrefix: /* @__PURE__ */ new Map(),
				size: 0
			};
			indexes.set(q.index, iw);
		}
		return {
			iw,
			key: prefixKey(q.prefix)
		};
	}
	add(w) {
		const { iw, key } = this.bucket(w.query);
		let set = iw.byPrefix.get(key);
		if (set === void 0) {
			set = /* @__PURE__ */ new Set();
			iw.byPrefix.set(key, set);
		}
		if (!set.has(w)) {
			set.add(w);
			iw.size++;
		}
	}
	remove(w) {
		const { iw, key } = this.bucket(w.query);
		const set = iw.byPrefix.get(key);
		if (set?.delete(w)) {
			iw.size--;
			if (set.size === 0) iw.byPrefix.delete(key);
		}
	}
	/** Adds to `out` every watcher whose query matches `row`. */
	collect(table, row, out) {
		const indexes = this.byTable.get(table);
		if (indexes === void 0) return;
		for (const iw of indexes.values()) {
			if (iw.size === 0) continue;
			const values = iw.cols.map((c) => row[c]);
			for (let len = 0; len <= values.length; len++) {
				const set = iw.byPrefix.get(prefixKey(values.slice(0, len)));
				if (set === void 0) continue;
				for (const w of set) if (matchesQuery(w.query, row)) out.add(w);
			}
		}
	}
};
//#endregion
//#region src/scope.ts
var Scope = class {
	parent;
	key;
	row;
	collections = [];
	reads = /* @__PURE__ */ new Map();
	emitted = /* @__PURE__ */ new Map();
	value = void 0;
	dirtyFull = false;
	dirtyPath = false;
	disposed = false;
	full = false;
	cursor = 0;
	claimed = /* @__PURE__ */ new Set();
	nextCollections = [];
	nextReads = /* @__PURE__ */ new Map();
	nextTask;
	task;
	constructor(parent, key, row) {
		this.parent = parent;
		this.key = key;
		this.row = row;
	}
};
var Collection = class {
	owner;
	kind;
	query;
	fn;
	reducer;
	rerunOn;
	children = /* @__PURE__ */ new Map();
	pending = /* @__PURE__ */ new Map();
	dirtyChildren = /* @__PURE__ */ new Set();
	dirtyPath = false;
	disposed = false;
	acc;
	result;
	watch;
	constructor(owner, kind, query, fn, reducer, rerunOn) {
		this.owner = owner;
		this.kind = kind;
		this.query = query;
		this.fn = fn;
		this.reducer = reducer;
		this.rerunOn = rerunOn;
		this.watch = {
			kind: "collection",
			query,
			coll: this
		};
	}
	/** The value folded for one child: its scope's return value. */
	resultOf() {
		const r = this.reducer;
		return r.result ? r.result(this.acc) : this.acc;
	}
};
var ScopeEngine = class {
	host;
	name;
	inputs;
	registry = new Registry();
	inbox = /* @__PURE__ */ new Map();
	root;
	rootFailed = false;
	busy = false;
	current;
	q;
	constructor(host, name, inputs) {
		this.host = host;
		this.name = name;
		this.inputs = inputs;
		this.q = {
			each: (query, fn, options) => this.collection("each", query, fn, void 0, options),
			reduce: (query, a, b, c) => typeof a === "function" ? this.collection("reduce", query, a, b, c) : this.collection("reduce", query, void 0, a, b),
			read: (query) => this.read(query)
		};
	}
	beforeRun(_scope) {}
	afterSuccess(_scope) {}
	afterFailure(_scope, _prevEmitted) {}
	onDispose(_scope) {}
	afterUpdate() {}
	/** Records a committed change to one of this engine's inputs. */
	record(table, key, before, after) {
		let changes = this.inbox.get(table);
		if (changes === void 0) {
			changes = /* @__PURE__ */ new Map();
			this.inbox.set(table, changes);
		}
		const prev = changes.get(key);
		if (prev === void 0) changes.set(key, {
			before,
			after
		});
		else if (prev.before === void 0 && after === void 0) changes.delete(key);
		else prev.after = after;
	}
	get stale() {
		return this.root === void 0 || this.inbox.size > 0;
	}
	/** Brings the scope tree up to date with the inbox. */
	update() {
		if (this.busy || !this.stale) return;
		this.busy = true;
		try {
			if (this.root === void 0) {
				this.inbox.clear();
				this.root = new Scope(void 0, void 0, void 0);
				this.runScope(this.root, true);
			} else {
				this.applyInbox();
				if (this.rootFailed) this.markFull(this.root);
				if (this.root.dirtyPath || this.root.dirtyFull) this.updateScope(this.root);
			}
			this.afterUpdate();
		} finally {
			this.busy = false;
		}
	}
	dispose() {
		if (this.root !== void 0) this.disposeScope(this.root);
		this.inbox.clear();
	}
	/** The registered name plus the key path of a scope. */
	pathOf(scope) {
		const keys = [];
		for (let s = scope; s?.parent !== void 0; s = s.parent.owner) keys.unshift(String(s.key));
		return [this.name, ...keys].join("/");
	}
	requireCurrent(what) {
		if (this.current === void 0) throw new Error(`millpond: ${what} can only be called while ${this.name} is running.`);
		return this.current;
	}
	applyInbox() {
		const hit = /* @__PURE__ */ new Set();
		for (const [table, changes] of this.inbox) for (const [key, { before, after }] of changes) {
			hit.clear();
			if (before !== void 0) this.registry.collect(table, before, hit);
			if (after !== void 0) this.registry.collect(table, after, hit);
			for (const w of hit) if (w.kind === "read") {
				if (!w.scope.disposed) this.markFull(w.scope);
			} else if (!w.coll.disposed) {
				const inAfter = after !== void 0 && matchesQuery(w.query, after);
				w.coll.pending.set(key, inAfter ? after : void 0);
				this.markCollection(w.coll);
			}
		}
		this.inbox.clear();
	}
	markFull(scope) {
		scope.dirtyFull = true;
		this.markPath(scope);
	}
	markPath(scope) {
		if (scope.dirtyPath) return;
		scope.dirtyPath = true;
		if (scope.parent !== void 0) {
			scope.parent.dirtyChildren.add(scope);
			this.markCollection(scope.parent);
		}
	}
	markCollection(coll) {
		if (coll.dirtyPath) return;
		coll.dirtyPath = true;
		this.markPath(coll.owner);
	}
	/** Updates a dirty scope. Returns whether its value changed. */
	updateScope(scope) {
		if (scope.disposed) return false;
		if (scope.dirtyFull) return this.runScope(scope, true);
		scope.dirtyPath = false;
		let changed = false;
		for (const coll of scope.collections) if (coll.dirtyPath && this.updateCollection(coll)) changed = true;
		return changed ? this.runScope(scope, false) : false;
	}
	/** Applies a collection's pending row diffs and dirty children. */
	updateCollection(coll) {
		coll.dirtyPath = false;
		const pending = coll.pending;
		coll.pending = /* @__PURE__ */ new Map();
		let changed = false;
		for (const [key, after] of pending) {
			if (after !== void 0) continue;
			const child = coll.children.get(key);
			if (child === void 0) continue;
			this.fold(coll, child.value, void 0, true, false);
			this.disposeScope(child);
			coll.children.delete(key);
			changed = true;
		}
		for (const [key, after] of pending) {
			if (after === void 0) continue;
			let child = coll.children.get(key);
			if (child === void 0) {
				child = new Scope(coll, key, after);
				coll.children.set(key, child);
				this.runScope(child, true);
				this.fold(coll, void 0, child.value, false, true);
				changed = true;
				continue;
			}
			const snapshot = child.row;
			if (coll.rerunOn?.every((f) => Object.is(snapshot[f], after[f]))) continue;
			const old = child.value;
			child.row = after;
			if (this.runScope(child, true)) {
				this.fold(coll, old, child.value, true, true);
				changed = true;
			}
		}
		const dirty = coll.dirtyChildren;
		coll.dirtyChildren = /* @__PURE__ */ new Set();
		for (const child of dirty) {
			if (child.disposed || !(child.dirtyPath || child.dirtyFull)) continue;
			const old = child.value;
			if (this.updateScope(child)) {
				this.fold(coll, old, child.value, true, true);
				changed = true;
			}
		}
		if (!changed) return false;
		if (coll.kind === "each") {
			coll.result = this.eachResult(coll, this.host.rows(coll.query));
			return true;
		}
		const next = coll.resultOf();
		const same = Object.is(next, coll.result);
		coll.result = next;
		return !same;
	}
	/** Folds a child's value change into a reduce accumulator. */
	fold(coll, old, next, hadOld, hasNext) {
		const r = coll.reducer;
		if (r === void 0) return;
		if (hadOld && hasNext && Object.is(old, next)) return;
		if (hadOld) coll.acc = r.remove(coll.acc, old);
		if (hasNext) coll.acc = r.add(coll.acc, next);
	}
	eachResult(coll, rows) {
		const key = coll.query.table.key;
		return rows.map((row) => coll.children.get(row[key])?.value);
	}
	/** Rebuilds a collection against the current rows, rerunning every child. */
	resync(coll) {
		coll.pending.clear();
		coll.dirtyChildren.clear();
		coll.dirtyPath = false;
		const rows = this.host.rows(coll.query);
		const keyField = coll.query.table.key;
		const live = new Set(rows.map((r) => r[keyField]));
		for (const [key, child] of coll.children) {
			if (live.has(key)) continue;
			this.disposeScope(child);
			coll.children.delete(key);
		}
		for (const row of rows) {
			const key = row[keyField];
			let child = coll.children.get(key);
			if (child === void 0) {
				child = new Scope(coll, key, row);
				coll.children.set(key, child);
			} else child.row = row;
			this.runScope(child, true);
		}
		if (coll.kind === "each") coll.result = this.eachResult(coll, rows);
		else {
			const r = coll.reducer;
			coll.acc = r.init();
			for (const row of rows) coll.acc = r.add(coll.acc, coll.children.get(row[keyField])?.value);
			coll.result = coll.resultOf();
		}
	}
	/**
	* Runs a scope's function. A full run reruns every child (they may have
	* captured changed values); otherwise collections return cached results.
	* Returns whether the scope's value changed.
	*/
	runScope(scope, full) {
		scope.dirtyFull = false;
		scope.dirtyPath = false;
		const prevEmitted = scope.emitted;
		const prevCollections = scope.collections;
		const prevReads = scope.reads;
		const prevValue = scope.value;
		this.beforeRun(scope);
		scope.emitted = /* @__PURE__ */ new Map();
		scope.full = full;
		scope.cursor = 0;
		scope.claimed = /* @__PURE__ */ new Set();
		scope.nextCollections = [];
		scope.nextReads = /* @__PURE__ */ new Map();
		scope.nextTask = void 0;
		const saved = this.current;
		this.current = scope;
		let ok = true;
		let value;
		let error;
		try {
			value = this.host.guard(() => this.invoke(scope));
		} catch (e) {
			ok = false;
			error = e;
		} finally {
			this.current = saved;
		}
		if (ok) {
			for (const c of prevCollections) if (!scope.claimed.has(c)) this.disposeCollection(c);
			scope.collections = scope.nextCollections;
			for (const [k, w] of prevReads) if (!scope.nextReads.has(k)) this.removeRead(w);
			scope.reads = scope.nextReads;
			scope.value = value;
			if (scope === this.root) this.rootFailed = false;
			this.afterSuccess(scope);
		} else {
			const kept = new Set(prevCollections);
			for (const c of scope.nextCollections) if (!kept.has(c)) this.disposeCollection(c);
			scope.collections = prevCollections;
			for (const [k, w] of scope.nextReads) if (!prevReads.has(k)) prevReads.set(k, w);
			scope.reads = prevReads;
			if (scope === this.root) this.rootFailed = true;
			this.afterFailure(scope, prevEmitted);
			this.host.report(error, this.pathOf(scope));
		}
		scope.claimed = /* @__PURE__ */ new Set();
		scope.nextCollections = [];
		scope.nextReads = /* @__PURE__ */ new Map();
		return ok && !Object.is(prevValue, value);
	}
	invoke(scope) {
		const coll = scope.parent;
		if (coll === void 0) {
			this.runRoot();
			return;
		}
		return coll.fn ? coll.fn(scope.row) : scope.row;
	}
	checkInput(query, what) {
		const q = internalOf(query, "query");
		if (!this.inputs.has(q.table)) throw new Error(`millpond: ${this.name} called ${what} on a table that is not one of its declared inputs.`);
		return q;
	}
	collection(kind, query, fn, reducer, options) {
		const scope = this.requireCurrent(`q.${kind}`);
		const q = this.checkInput(query, `q.${kind}`);
		if (kind === "each" && typeof fn !== "function") throw new TypeError("millpond: q.each expects a function.");
		if (kind === "reduce" && typeof reducer?.init !== "function") throw new TypeError("millpond: q.reduce expects a reducer ({ init, add, remove }).");
		const old = scope.collections[scope.cursor++];
		let coll;
		if (old !== void 0 && !scope.claimed.has(old) && old.kind === kind && old.query.key === q.key && old.reducer === reducer && old.fn === void 0 === (fn === void 0)) {
			coll = old;
			coll.fn = fn;
			coll.rerunOn = options?.rerunOn;
			scope.claimed.add(coll);
			if (scope.full) this.resync(coll);
		} else {
			coll = new Collection(scope, kind, q, fn, reducer, options?.rerunOn);
			this.registry.add(coll.watch);
			this.resync(coll);
		}
		scope.nextCollections.push(coll);
		return coll.result;
	}
	read(query) {
		const scope = this.requireCurrent("q.read");
		const q = this.checkInput(query, "q.read");
		if (!scope.nextReads.has(q.key)) {
			let w = scope.reads.get(q.key);
			if (w === void 0) {
				w = {
					kind: "read",
					query: q,
					scope
				};
				this.registry.add(w);
				this.host.retain(q);
			}
			scope.nextReads.set(q.key, w);
		}
		return this.host.readQuery(q);
	}
	disposeScope(scope) {
		if (scope.disposed) return;
		scope.disposed = true;
		for (const c of scope.collections) this.disposeCollection(c);
		for (const w of scope.reads.values()) this.removeRead(w);
		this.onDispose(scope);
	}
	removeRead(w) {
		this.registry.remove(w);
		this.host.release(w.query);
	}
	disposeCollection(coll) {
		if (coll.disposed) return;
		coll.disposed = true;
		this.registry.remove(coll.watch);
		for (const child of coll.children.values()) this.disposeScope(child);
		coll.children.clear();
	}
};
var AggregateEngine = class extends ScopeEngine {
	table;
	compute;
	sink;
	/** Which scope currently owns each output key. */
	owners = /* @__PURE__ */ new Map();
	touched = /* @__PURE__ */ new Set();
	upstream = [];
	emit;
	constructor(host, name, inputs, table, compute, sink) {
		super(host, name, inputs);
		this.table = table;
		this.compute = compute;
		this.sink = sink;
		this.emit = (row) => this.emitRow(row);
	}
	runRoot() {
		this.compute(this.q, this.emit);
	}
	emitRow(input) {
		const scope = this.requireCurrent("emit");
		const row = this.sink.prepare(input);
		const key = row[this.table.key];
		const owner = this.owners.get(key);
		if (owner !== void 0 && owner !== scope && !owner.disposed) throw new Error(`millpond: ${this.name}: two scopes emitted the key ${JSON.stringify(key)} (${this.pathOf(owner)} and ${this.pathOf(scope)}).`);
		this.owners.set(key, scope);
		scope.emitted.set(key, row);
		this.touched.add(key);
	}
	release(scope, keys) {
		for (const k of keys) {
			if (this.owners.get(k) === scope) this.owners.delete(k);
			this.touched.add(k);
		}
	}
	beforeRun(scope) {
		this.release(scope, scope.emitted.keys());
	}
	afterFailure(scope, prevEmitted) {
		this.release(scope, scope.emitted.keys());
		scope.emitted = prevEmitted;
		for (const k of prevEmitted.keys()) {
			const owner = this.owners.get(k);
			if (owner === void 0 || owner.disposed) this.owners.set(k, scope);
			this.touched.add(k);
		}
	}
	onDispose(scope) {
		this.release(scope, scope.emitted.keys());
	}
	afterUpdate() {
		const touched = this.touched;
		this.touched = /* @__PURE__ */ new Set();
		for (const key of touched) {
			const owner = this.owners.get(key);
			this.sink.write(key, owner?.emitted.get(key));
		}
	}
};
var EffectEngine = class extends ScopeEngine {
	watch;
	disabled = false;
	/** Consecutive chained flushes in which this effect started tasks. */
	streak = 0;
	starts = [];
	/** Why disposing a scope aborts its task; the db sets it when disabling the effect. */
	disposeReason = "scopeDisposed";
	task;
	constructor(host, name, inputs, watch) {
		super(host, name, inputs);
		this.watch = watch;
		this.task = (fn, options) => {
			const scope = this.requireCurrent("task");
			if (typeof fn !== "function") throw new TypeError("millpond: task expects a function.");
			if (scope.nextTask !== void 0) throw new Error(`millpond: ${this.pathOf(scope)} registered more than one task.`);
			scope.nextTask = {
				fn,
				label: options?.label
			};
		};
	}
	runRoot() {
		this.watch(this.q, this.task);
	}
	afterSuccess(scope) {
		const prev = scope.task;
		if (prev !== void 0) abortTask(prev, "restarted");
		scope.task = void 0;
		if (scope.nextTask !== void 0) {
			scope.task = {
				fn: scope.nextTask.fn,
				scope,
				label: scope.nextTask.label,
				restartOf: prev === void 0 ? null : prev.id ?? prev.restartOf,
				id: void 0,
				controller: void 0,
				cancelled: false,
				onAbort: void 0
			};
			this.starts.push(scope.task);
		}
		scope.nextTask = void 0;
	}
	afterFailure(scope) {
		scope.nextTask = void 0;
	}
	onDispose(scope) {
		if (scope.task !== void 0) abortTask(scope.task, this.disposeReason);
		scope.task = void 0;
	}
	takeStarts() {
		const starts = this.starts.filter((t) => !t.cancelled && !t.scope.disposed);
		this.starts = [];
		return starts;
	}
};
function abortTask(task, reason) {
	if (task.cancelled) return;
	task.cancelled = true;
	task.controller?.abort();
	task.onAbort?.(reason);
}
//#endregion
//#region src/db.ts
function createDb(options) {
	const engine = new Engine(options);
	engines.set(engine.db, engine);
	return engine.db;
}
const engines = /* @__PURE__ */ new WeakMap();
/** Consecutive flushes in which an effect may restart its tasks. */
const FLUSH_CAP = 100;
/** Finished task runs kept per effect in `sys.tasks` by default. */
const DEFAULT_HISTORY = 20;
const DELETED = Symbol("deleted");
const fmt = (v) => typeof v === "string" ? JSON.stringify(v) : String(v);
var Engine = class {
	db;
	validate;
	freeze;
	onError;
	disposed = false;
	tables = /* @__PURE__ */ new Map();
	ops = /* @__PURE__ */ new Map();
	aggregates = [];
	aggregateOf = /* @__PURE__ */ new Map();
	effects = [];
	dependents = /* @__PURE__ */ new Map();
	introspection;
	cache = /* @__PURE__ */ new Map();
	get cachedQueryCount() {
		return this.cache.size;
	}
	cacheWatchers = new Registry();
	dirtyEntries = /* @__PURE__ */ new Set();
	/** Nonzero while subscribers, compute or watch functions run. */
	noWrite = 0;
	tx;
	flushScheduled = false;
	inFlush = false;
	nextChained = false;
	errors = [];
	constructor(options) {
		this.validate = options.validate ?? true;
		this.freeze = options.freeze ?? true;
		this.onError = options.onError;
		const { introspect } = options;
		if (introspect) {
			const history = typeof introspect === "object" ? introspect.history : void 0;
			for (const [def, name] of SYS_NAMES) this.tables.set(def, new TableState(def, name));
			this.introspection = new Introspection({
				stateOf: (def) => this.tables.get(def),
				write: (ts, key, row) => this.writeSystem(ts, key, row)
			}, history ?? DEFAULT_HISTORY);
		}
		this.register(options.features ?? {});
		const readonlyDb = { read: (q) => this.read(q) };
		this.readonlyDb = readonlyDb;
		this.db = {
			ops: this.opsTree(options.features ?? {}),
			read: (q) => this.read(q),
			subscribe: (q, listener) => this.subscribe(q, listener),
			run: (op, args) => this.run(op, args),
			dispose: () => this.dispose()
		};
	}
	readonlyDb;
	register(features) {
		const effects = [];
		const tableValues = [];
		const seen = /* @__PURE__ */ new Set();
		const claim = (value, name) => {
			if (seen.has(value)) throw new Error(`millpond: ${name} is already registered under another name.`);
			seen.add(value);
		};
		for (const [fname, feature] of Object.entries(features)) {
			const fd = internalOf(feature, "feature");
			for (const [key, t] of Object.entries(fd.tables)) {
				const def = internalOf(t, "table");
				const sysName = SYS_NAMES.get(def);
				if (sysName !== void 0) throw new Error(`millpond: ${sysName} is a system table and cannot be registered as ${fname}.${key}.`);
				claim(def, `${fname}.${key}`);
				const state = new TableState(def, `${fname}.${key}`);
				this.tables.set(def, state);
				tableValues.push({
					state,
					value: t
				});
			}
			for (const [key, o] of Object.entries(fd.ops)) {
				claim(o, `${fname}.${key}`);
				this.ops.set(o, {
					def: internalOf(o, "op"),
					name: `${fname}.${key}`
				});
			}
			for (const [key, e] of Object.entries(fd.effects)) {
				claim(e, `${fname}.${key}`);
				effects.push([
					`${fname}.${key}`,
					internalOf(e, "effect"),
					e
				]);
			}
		}
		const inputsOf = (name, inputs) => {
			const defs = /* @__PURE__ */ new Set();
			for (const input of inputs) {
				const def = internalOf(input, "table");
				if (!this.tables.has(def)) {
					const sysName = SYS_NAMES.get(def);
					throw new Error(sysName === void 0 ? `millpond: ${name} has an input that is not registered with the db.` : `millpond: ${name} reads ${sysName}, which requires createDb({ introspect: true }).`);
				}
				defs.add(def);
			}
			return defs;
		};
		const effectInputs = effects.map(([name, def]) => {
			const inputs = inputsOf(name, def.inputs);
			for (const input of inputs) {
				const sysName = SYS_NAMES.get(input);
				if (sysName !== void 0) throw new Error(`millpond: ${name} cannot watch the system table ${sysName}.`);
			}
			return inputs;
		});
		this.introspection?.init(tableValues, effects.map(([name], i) => ({
			name,
			inputs: [...effectInputs[i] ?? []].map((d) => this.tables.get(d)?.name ?? "")
		})));
		const state = /* @__PURE__ */ new Map();
		const visit = (def) => {
			const agg = def.aggregate;
			if (agg === void 0 || state.get(def) === "done") return;
			const ts = this.tables.get(def);
			if (state.get(def) === "visiting") throw new Error(`millpond: aggregate ${ts.name} depends on itself.`);
			state.set(def, "visiting");
			const inputs = inputsOf(ts.name, agg.inputs);
			for (const input of inputs) visit(input);
			const engine = new AggregateEngine(this, ts.name, inputs, def, agg.compute, {
				prepare: (row) => this.prepare(ts, { ...row }),
				write: (key, row) => this.writeOutput(ts, key, row)
			});
			for (const input of inputs) {
				const up = this.aggregateOf.get(input);
				if (up !== void 0) engine.upstream.push(up);
			}
			this.aggregates.push(engine);
			this.aggregateOf.set(def, engine);
			this.addDependent(engine);
			state.set(def, "done");
		};
		for (const def of this.tables.keys()) visit(def);
		for (const [i, [name, def]] of effects.entries()) {
			const engine = new EffectEngine(this, name, effectInputs[i] ?? /* @__PURE__ */ new Set(), def.watch);
			this.effects.push(engine);
			this.addDependent(engine);
		}
	}
	addDependent(engine) {
		for (const input of engine.inputs) {
			let list = this.dependents.get(input);
			if (list === void 0) {
				list = [];
				this.dependents.set(input, list);
			}
			list.push(engine);
		}
	}
	opsTree(features) {
		const tree = {};
		for (const [fname, feature] of Object.entries(features)) {
			const branch = {};
			for (const [key, o] of Object.entries(internalOf(feature, "feature").ops)) branch[key] = (args) => this.run(o, args);
			tree[fname] = branch;
		}
		return tree;
	}
	assertAlive() {
		if (this.disposed) throw new Error("millpond: the db has been disposed.");
	}
	/** The state of a registered table, brought up to date if it's an aggregate. */
	readable(def) {
		const ts = this.tables.get(def);
		if (ts === void 0) throw this.unregistered(def);
		const agg = this.aggregateOf.get(def);
		if (agg !== void 0) this.ensureFresh(agg);
		return ts;
	}
	writable(table) {
		const def = internalOf(table, "table");
		const sysName = SYS_NAMES.get(def);
		if (sysName !== void 0) throw new Error(`millpond: ${sysName} is a system table, which only the db writes.`);
		const ts = this.tables.get(def);
		if (ts === void 0) throw this.unregistered(def);
		if (def.aggregate !== void 0) throw new Error(`millpond: ${ts.name} is an aggregate, which is read-only.`);
		return ts;
	}
	unregistered(def) {
		const sysName = SYS_NAMES.get(def);
		return /* @__PURE__ */ new Error(sysName === void 0 ? "millpond: this table is not registered with the db." : `millpond: reading ${sysName} requires createDb({ introspect: true }).`);
	}
	ensureFresh(agg) {
		if (agg.busy) return;
		for (const up of agg.upstream) this.ensureFresh(up);
		agg.update();
	}
	guard(fn) {
		this.noWrite++;
		try {
			return fn();
		} finally {
			this.noWrite--;
		}
	}
	prepare(ts, row) {
		if (this.validate) {
			let res;
			try {
				res = ts.def.schema["~standard"].validate(row);
			} catch (e) {
				throw new Error(`millpond: ${ts.name}: the schema failed to validate synchronously.`, { cause: e });
			}
			if (isThenable(res)) {
				res.then(void 0, () => {});
				throw new Error(`millpond: ${ts.name} has an async schema; ops are synchronous, so it cannot be used.`);
			}
			if (res.issues !== void 0) {
				const detail = res.issues.map((i) => {
					const path = i.path?.map((p) => typeof p === "object" ? p.key : p).join(".");
					return path ? `${path}: ${i.message}` : i.message;
				}).join("; ");
				throw new Error(`millpond: invalid row for ${ts.name}: ${detail}`);
			}
			if (!deepEqual(res.value, row)) throw new Error(`millpond: ${ts.name}: the schema's output differs from its input. Schemas only validate, so defaults and transforms are not supported.`);
		}
		if (this.freeze) Object.freeze(row);
		return row;
	}
	read(query) {
		this.assertAlive();
		return this.readQuery(internalOf(query, "query"));
	}
	/**
	* A committed read. A watched query reads through its cache entry, so an
	* unchanged result keeps its identity; anything else is computed fresh.
	*/
	readQuery(q) {
		const ts = this.readable(q.table);
		const entry = this.cache.get(q.key);
		if (entry === void 0) return ts.read(q);
		if (entry.dirty) {
			const next = ts.read(q);
			if (!sameResult(entry.result, next)) entry.result = next;
			entry.dirty = false;
		}
		return entry.result;
	}
	/** The cache entry for a query, created on first use. */
	entryFor(q) {
		let entry = this.cache.get(q.key);
		if (entry === void 0) {
			entry = {
				query: q,
				result: this.readable(q.table).read(q),
				dirty: false,
				listeners: /* @__PURE__ */ new Set(),
				scopeRefs: 0
			};
			this.cache.set(q.key, entry);
			this.cacheWatchers.add(entry);
		}
		return entry;
	}
	/** Drops an entry once nothing watches it any more. */
	releaseEntry(entry) {
		if (entry.listeners.size > 0 || entry.scopeRefs > 0) return;
		if (this.cache.get(entry.query.key) !== entry) return;
		this.cache.delete(entry.query.key);
		this.cacheWatchers.remove(entry);
		this.dirtyEntries.delete(entry);
	}
	retain(q) {
		this.entryFor(q).scopeRefs++;
	}
	release(q) {
		const entry = this.cache.get(q.key);
		if (entry === void 0) return;
		entry.scopeRefs--;
		this.releaseEntry(entry);
	}
	rows(q) {
		const result = this.readable(q.table).read(q);
		if (q.single) return result === void 0 ? [] : [result];
		return result;
	}
	subscribe(query, listener) {
		this.assertAlive();
		const q = internalOf(query, "query");
		const entry = this.entryFor(q);
		const result = this.readQuery(q);
		const l = {
			fn: listener,
			last: result
		};
		entry.listeners.add(l);
		this.callListener(l, result, q);
		return () => {
			if (entry.listeners.delete(l)) this.releaseEntry(entry);
		};
	}
	callListener(l, result, q) {
		try {
			this.guard(() => l.fn(result));
		} catch (e) {
			this.report(e, `${this.tables.get(q.table)?.name ?? "query"} subscriber`);
		}
	}
	run(op, args) {
		this.assertAlive();
		if (this.noWrite > 0) throw new Error("millpond: ops cannot be called from subscribers, compute or watch functions.");
		if (this.tx !== void 0) throw new Error("millpond: use tx.run to call an op from inside another op.");
		const reg = this.opOf(op);
		const tx = new Tx(this);
		this.tx = tx;
		try {
			tx.exec(reg, args);
		} finally {
			this.tx = void 0;
			tx.closed = true;
		}
		this.commit(tx.overlay);
	}
	opOf(op) {
		const reg = typeof op === "object" && op !== null ? this.ops.get(op) : void 0;
		if (reg === void 0) throw new Error("millpond: this op is not registered with the db.");
		return reg;
	}
	commit(overlay) {
		let changed = false;
		for (const [ts, slots] of overlay) for (const [key, slot] of slots) {
			const before = ts.rows.get(key);
			if (slot === DELETED) {
				if (before === void 0) continue;
				ts.delete(key);
				this.recordChange(ts, key, before, void 0);
			} else {
				ts.set(key, slot);
				this.recordChange(ts, key, before, slot);
			}
			changed = true;
		}
		if (changed) this.scheduleFlush(true);
	}
	/** Writes one aggregate output row if it differs from the stored one. */
	writeOutput(ts, key, row) {
		const before = ts.rows.get(key);
		if (row === void 0) {
			if (before === void 0) return;
			ts.delete(key);
		} else {
			if (before !== void 0 && shallowEqual(before, row)) return;
			ts.set(key, row);
		}
		this.recordChange(ts, key, before, row);
		if (!this.inFlush) this.scheduleFlush(false);
	}
	/** Writes one system row on the db's behalf, outside any op. */
	writeSystem(ts, key, row) {
		if (this.disposed) return;
		const before = ts.rows.get(key);
		if (row === void 0) {
			if (before === void 0) return;
			ts.delete(key);
		} else {
			if (this.freeze) Object.freeze(row);
			ts.set(key, row);
		}
		this.recordChange(ts, key, before, row);
		this.scheduleFlush(false);
	}
	recordChange(ts, key, before, after) {
		const hit = /* @__PURE__ */ new Set();
		if (before !== void 0) this.cacheWatchers.collect(ts.def, before, hit);
		if (after !== void 0) this.cacheWatchers.collect(ts.def, after, hit);
		for (const entry of hit) {
			entry.dirty = true;
			if (entry.listeners.size > 0) this.dirtyEntries.add(entry);
		}
		for (const engine of this.dependents.get(ts.def) ?? []) engine.record(ts.def, key, before, after);
	}
	scheduleFlush(fromOp) {
		if (this.inFlush && fromOp) this.nextChained = true;
		if (this.flushScheduled) return;
		this.flushScheduled = true;
		queueMicrotask(() => this.flush());
	}
	flush() {
		this.flushScheduled = false;
		if (this.disposed) return;
		const chained = this.nextChained;
		this.nextChained = false;
		this.inFlush = true;
		try {
			for (const agg of this.aggregates) this.ensureFresh(agg);
			const dirty = this.dirtyEntries;
			this.dirtyEntries = /* @__PURE__ */ new Set();
			for (const entry of dirty) {
				if (this.disposed) return;
				if (entry.listeners.size === 0) continue;
				let result;
				try {
					result = this.readQuery(entry.query);
				} catch (e) {
					this.report(e, "subscriber");
					continue;
				}
				for (const l of [...entry.listeners]) {
					if (this.disposed) return;
					if (Object.is(l.last, result) || !entry.listeners.has(l)) continue;
					l.last = result;
					this.callListener(l, result, entry.query);
				}
			}
			for (const effect of this.effects) if (!effect.disabled) effect.update();
			this.deliverErrors();
			this.startTasks(chained);
		} finally {
			this.inFlush = false;
		}
		if (this.errors.length > 0) this.scheduleFlush(false);
	}
	startTasks(chained) {
		for (const effect of this.effects) {
			const starts = effect.disabled ? [] : effect.takeStarts();
			if (starts.length === 0) {
				effect.streak = 0;
				continue;
			}
			effect.streak = chained ? effect.streak + 1 : 1;
			if (effect.streak > FLUSH_CAP) {
				effect.disabled = true;
				effect.disposeReason = "effectDisabled";
				effect.dispose();
				this.introspection?.disable(effect.name);
				this.report(/* @__PURE__ */ new Error(`millpond: ${effect.name} restarted its tasks in more than ${FLUSH_CAP} consecutive flushes and has been disabled.`), effect.name);
				continue;
			}
			for (const task of starts) {
				if (this.disposed || effect.disabled) return;
				this.startTask(effect, task);
			}
		}
	}
	startTask(effect, task) {
		if (task.cancelled || task.scope.disposed) return;
		const controller = new AbortController();
		task.controller = controller;
		const { signal } = controller;
		const source = effect.pathOf(task.scope);
		const insp = this.introspection;
		let record;
		if (insp !== void 0) {
			const rec = insp.start(effect.name, source, task.label, task.restartOf);
			record = rec;
			task.id = rec.id;
			task.onAbort = (reason) => insp.aborted(rec, reason);
		}
		const ctx = {
			db: this.readonlyDb,
			signal,
			run: (op, args, opts) => {
				if (signal.aborted && !opts?.ignoreAbort) throw abortError();
				this.run(op, args);
			},
			note: (detail) => {
				if (record !== void 0) insp?.note(record, detail);
			}
		};
		const done = () => {
			if (record !== void 0) insp?.end(record, "done");
		};
		const fail = (e) => {
			if (record !== void 0) {
				if (isAbortError(e)) insp?.end(record, "aborted");
				else insp?.end(record, "failed", e);
			}
			if (!isAbortError(e) && !this.disposed) this.report(e, source);
		};
		try {
			const r = task.fn(ctx);
			if (isThenable(r)) r.then(done, fail);
			else done();
		} catch (e) {
			fail(e);
		}
	}
	report(err, source) {
		if (this.disposed) return;
		this.errors.push({
			err,
			source
		});
		if (!this.inFlush) this.scheduleFlush(false);
	}
	deliverErrors() {
		const errors = this.errors;
		this.errors = [];
		for (const { err, source } of errors) {
			const onError = this.onError;
			if (onError === void 0) {
				queueMicrotask(() => {
					throw err;
				});
				continue;
			}
			try {
				onError(err, {
					db: this.db,
					source
				});
			} catch (e) {
				queueMicrotask(() => {
					if (e instanceof Error && e.cause === void 0) e.cause = err;
					throw e instanceof Error ? e : new Error(String(e), { cause: err });
				});
			}
		}
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		for (const effect of this.effects) effect.dispose();
		for (const agg of this.aggregates) agg.dispose();
		for (const entry of this.cache.values()) entry.listeners.clear();
		this.cache.clear();
		this.dirtyEntries.clear();
		this.errors = [];
	}
};
/**
* An op's transaction. Writes go to an overlay over the committed tables, so
* reads inside the op see them while aggregates still see the op's start. An
* undo log makes nested ops savepoints.
*/
var Tx = class {
	engine;
	overlay = /* @__PURE__ */ new Map();
	undo = [];
	closed = false;
	constructor(engine) {
		this.engine = engine;
	}
	exec(reg, args) {
		const mark = this.undo.length;
		try {
			const r = reg.def.fn(this, args);
			if (isThenable(r)) {
				r.then(void 0, () => {});
				throw new Error(`millpond: op ${reg.name} returned a promise; ops must be synchronous.`);
			}
		} catch (e) {
			this.rollback(mark);
			throw e;
		}
	}
	rollback(mark) {
		while (this.undo.length > mark) {
			const u = this.undo.pop();
			const slots = this.overlay.get(u.ts);
			if (u.had) slots.set(u.key, u.prev);
			else slots.delete(u.key);
		}
	}
	assertOpen() {
		if (this.closed) throw new Error("millpond: this transaction has already finished.");
	}
	current(ts, key) {
		const slots = this.overlay.get(ts);
		if (slots?.has(key)) {
			const slot = slots.get(key);
			return slot === DELETED ? void 0 : slot;
		}
		return ts.rows.get(key);
	}
	write(ts, key, slot) {
		let slots = this.overlay.get(ts);
		if (slots === void 0) {
			slots = /* @__PURE__ */ new Map();
			this.overlay.set(ts, slots);
		}
		this.undo.push({
			ts,
			key,
			had: slots.has(key),
			prev: slots.get(key)
		});
		slots.set(key, slot);
	}
	withKey(ts, row) {
		if (typeof row !== "object" || row === null) throw new TypeError(`millpond: ${ts.name}: a row must be an object.`);
		const copy = { ...row };
		const { key, generate } = ts.def;
		if (copy[key] === void 0 && generate !== void 0) copy[key] = generate();
		if (copy[key] === void 0) throw new Error(`millpond: ${ts.name}: the row is missing its key "${key}".`);
		return copy;
	}
	insert(table, row) {
		this.assertOpen();
		const ts = this.engine.writable(table);
		const next = this.withKey(ts, row);
		const key = next[ts.def.key];
		if (this.current(ts, key) !== void 0) throw new Error(`millpond: ${ts.name}: a row with key ${fmt(key)} already exists.`);
		this.write(ts, key, this.engine.prepare(ts, next));
		return key;
	}
	update(table, key, patch) {
		this.assertOpen();
		const ts = this.engine.writable(table);
		const cur = this.current(ts, key);
		if (cur === void 0) throw new Error(`millpond: ${ts.name}: no row with key ${fmt(key)} to update.`);
		const p = typeof patch === "function" ? patch(cur) : patch;
		const keyField = ts.def.key;
		if (p != null && Object.hasOwn(p, keyField) && !Object.is(p[keyField], key)) throw new Error(`millpond: ${ts.name}: an update cannot change the key "${keyField}".`);
		this.write(ts, key, this.engine.prepare(ts, {
			...cur,
			...p
		}));
	}
	upsert(table, row) {
		this.assertOpen();
		const ts = this.engine.writable(table);
		const next = this.withKey(ts, row);
		const key = next[ts.def.key];
		this.write(ts, key, this.engine.prepare(ts, next));
		return key;
	}
	delete(table, key) {
		this.assertOpen();
		const ts = this.engine.writable(table);
		if (this.current(ts, key) === void 0) throw new Error(`millpond: ${ts.name}: no row with key ${fmt(key)} to delete.`);
		this.write(ts, key, DELETED);
	}
	read(query) {
		this.assertOpen();
		const q = internalOf(query, "query");
		const ts = this.engine.readable(q.table);
		const slots = this.overlay.get(ts);
		if (slots === void 0 || slots.size === 0) return this.engine.readQuery(q);
		if (q.single) return this.current(ts, q.prefix[0]);
		const keyField = ts.def.key;
		const out = ts.read(q).filter((r) => !slots.has(r[keyField]));
		for (const slot of slots.values()) if (slot !== DELETED && matchesQuery(q, slot)) out.push(slot);
		return out;
	}
	run(op, args) {
		this.assertOpen();
		this.exec(this.engine.opOf(op), args);
	}
};
//#endregion
//#region src/effect.ts
function effect(config) {
	for (const input of config.inputs) internalOf(input, "table or aggregate as input");
	const def = {
		inputs: [...config.inputs],
		watch: config.watch
	};
	return {
		kind: "effect",
		[INTERNAL]: def
	};
}
//#endregion
//#region src/feature.ts
function feature(config) {
	const def = {
		tables: { ...config.tables },
		ops: { ...config.ops },
		effects: { ...config.effects }
	};
	return {
		kind: "feature",
		[INTERNAL]: def
	};
}
//#endregion
//#region src/op.ts
function op(fn) {
	if (typeof fn !== "function") throw new TypeError("millpond: op() expects a function.");
	const def = { fn };
	return {
		kind: "op",
		[INTERNAL]: def
	};
}
//#endregion
//#region src/reducers.ts
/** Counts rows. O(1) per change. */
const count = {
	init: () => 0,
	add: (acc) => acc + 1,
	remove: (acc) => acc - 1
};
/** Sums numeric values. O(1) per change. */
const sum = {
	init: () => 0,
	add: (acc, value) => acc + value,
	remove: (acc, value) => acc - value
};
/** Index of the first element not less than `value` in a sorted array. */
function lowerBound(arr, value) {
	let lo = 0;
	let hi = arr.length;
	while (lo < hi) {
		const mid = lo + hi >>> 1;
		const cur = arr[mid];
		if (cur !== void 0 && cur < value) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}
function sortedInsert(arr, value) {
	arr.splice(lowerBound(arr, value), 0, value);
}
function sortedRemove(arr, value) {
	const i = lowerBound(arr, value);
	if (arr[i] === value) arr.splice(i, 1);
}
/**
* Smallest value in the group, or `undefined` when empty. Keeps every child's
* value in a sorted array, so O(log n) per change and O(n) memory.
*/
const min = {
	init: () => [],
	add: (acc, value) => {
		sortedInsert(acc, value);
		return acc;
	},
	remove: (acc, value) => {
		sortedRemove(acc, value);
		return acc;
	},
	result: (acc) => acc[0]
};
/** Largest value in the group, or `undefined` when empty. See `min`. */
const max = {
	init: () => [],
	add: (acc, value) => {
		sortedInsert(acc, value);
		return acc;
	},
	remove: (acc, value) => {
		sortedRemove(acc, value);
		return acc;
	},
	result: (acc) => acc[acc.length - 1]
};
//#endregion
//#region src/index.ts
/** The package version. */
const VERSION = "0.0.0";
//#endregion
export { VERSION, aggregate, count, createDb, effect, feature, max, min, op, sum, sys, table };

//# sourceMappingURL=index.mjs.map