import { z } from "zod";
import { aggregate, count, createDb, effect, feature, op, sum, table } from "../../src/index";
import { pick, randomBetween, wait } from "../util";

const id = () => crypto.randomUUID().slice(0, 8);

// --- Catalog --------------------------------------------------------------------------

/**
 * What each kind of building costs and catches. Every catch rate works out to
 * a whole number of fish per minute, so the `sum` reducers stay exact.
 */
export const CATALOG = {
  angler: { name: "Angler", icon: "🎣", baseCost: 15, cycleMs: 3_000, catch: 1 },
  trap: { name: "Fish trap", icon: "🪤", baseCost: 100, cycleMs: 5_000, catch: 5 },
  net: { name: "Net crew", icon: "🕸️", baseCost: 1_100, cycleMs: 6_000, catch: 48 },
  trawler: { name: "Trawler", icon: "🚢", baseCost: 12_000, cycleMs: 12_000, catch: 564 },
  farm: { name: "Fish farm", icon: "🏭", baseCost: 130_000, cycleMs: 20_000, catch: 5_200 },
} as const;

export type Kind = keyof typeof CATALOG;
export const KINDS = Object.keys(CATALOG) as Kind[];

/** Each building of a kind costs 15% more than the last. */
const PRICE_GROWTH = 1.15;
/** Each upgrade doubles a kind's catch; the first costs 10× a building, then 8× more each. */
const upgradeCost = (kind: Kind, tier: number) => CATALOG[kind].baseCost * 10 * 8 ** tier;
/** Fish per catch for a kind at an upgrade tier. */
export const catchOf = (kind: Kind, tier: number) => CATALOG[kind].catch * 2 ** tier;

/** A golden koi pays out a minute of production, but never less than this. */
const KOI_MIN_REWARD = 50;
const KOI_LIFETIME_MS = 8_000;

// --- Tables ---------------------------------------------------------------------------

const kind = z.enum(KINDS as [Kind, ...Kind[]]);

/** The single row holding the player's fish and lifetime stats. */
export const pond = table(
  z.object({
    id: z.literal("pond"),
    fish: z.number(),
    caught: z.number(),
    casts: z.number(),
    koiCaught: z.number(),
  }),
  { key: "id" },
);

/** One row per kind, holding how many times it has been upgraded. */
export const blueprints = table(z.object({ kind, tier: z.number() }), { key: "kind" });

/** One row per building. Each gets its own task in the `work` effect. */
export const buildings = table(
  z.object({
    id: z.string(),
    kind,
    /** 1 for the first building of its kind, and so on. */
    serial: z.number(),
    /** Doubled by each golden koi that picks this building. */
    speed: z.number(),
    builtAt: z.number(),
    catches: z.number(),
    lastCatchAt: z.number().nullable(),
  }),
  { key: "id", generate: id, indexes: { byKind: ["kind"] } },
);

/** Golden koi currently swimming. Catching one or letting it go deletes the row. */
export const koi = table(
  z.object({ id: z.string(), appearedAt: z.number(), escapesAt: z.number() }),
  { key: "id", generate: id },
);

/** Per kind: how many are owned, what they produce, and what the next ones cost. */
export const fleet = aggregate({
  table: table(
    z.object({
      kind,
      owned: z.number(),
      perMinute: z.number(),
      nextCost: z.number(),
      upgradeCost: z.number(),
    }),
    { key: "kind" },
  ),
  inputs: [blueprints, buildings],
  compute: (q, emit) =>
    q.each(blueprints.all(), (bp) => {
      const ofKind = buildings.byKind.kindEq(bp.kind);
      const owned = q.reduce(ofKind, count);
      // A building at speed 2 catches as often as two at speed 1.
      const speed = q.reduce(ofKind, (b) => b.speed, sum, { rerunOn: ["speed"] });
      const { cycleMs, baseCost } = CATALOG[bp.kind];
      emit({
        kind: bp.kind,
        owned,
        perMinute: (speed * catchOf(bp.kind, bp.tier) * 60_000) / cycleMs,
        nextCost: Math.ceil(baseCost * PRICE_GROWTH ** owned),
        upgradeCost: upgradeCost(bp.kind, bp.tier),
      });
    }),
});

/** The whole pond's production: an aggregate over another aggregate. */
export const economy = aggregate({
  table: table(z.object({ id: z.literal("pond"), perMinute: z.number() }), { key: "id" }),
  inputs: [fleet],
  compute: (q, emit) =>
    emit({ id: "pond", perMinute: q.reduce(fleet.all(), (f) => f.perMinute, sum) }),
});

// --- Ops ------------------------------------------------------------------------------

export const newGame = op((tx) => {
  tx.upsert(pond, { id: "pond", fish: 0, caught: 0, casts: 0, koiCaught: 0 });
  for (const kind of KINDS) tx.upsert(blueprints, { kind, tier: 0 });
  for (const b of tx.read(buildings.all())) tx.delete(buildings, b.id);
  for (const k of tx.read(koi.all())) tx.delete(koi, k.id);
});

export const cast = op((tx) => {
  tx.update(pond, "pond", (p) => ({ fish: p.fish + 1, caught: p.caught + 1, casts: p.casts + 1 }));
});

/** Buys the next building of a kind, if the player can afford it. */
export const build = op((tx, { kind }: { kind: Kind }) => {
  const f = tx.read(fleet.get(kind));
  const p = tx.read(pond.get("pond"));
  if (f === undefined || p === undefined || p.fish < f.nextCost) return;
  tx.update(pond, "pond", { fish: p.fish - f.nextCost });
  tx.insert(buildings, {
    kind,
    serial: f.owned + 1,
    speed: 1,
    builtAt: Date.now(),
    catches: 0,
    lastCatchAt: null,
  });
});

/** Doubles every building of a kind, if the player owns one and can afford it. */
export const upgrade = op((tx, { kind }: { kind: Kind }) => {
  const f = tx.read(fleet.get(kind));
  const p = tx.read(pond.get("pond"));
  if (f === undefined || p === undefined || f.owned === 0 || p.fish < f.upgradeCost) return;
  tx.update(pond, "pond", { fish: p.fish - f.upgradeCost });
  tx.update(blueprints, kind, (bp) => ({ tier: bp.tier + 1 }));
});

/** A building lands its catch, at its kind's current tier. */
export const landCatch = op((tx, { buildingId }: { buildingId: string }) => {
  const b = tx.read(buildings.get(buildingId));
  const bp = b && tx.read(blueprints.get(b.kind));
  if (b === undefined || bp === undefined) return;
  const amount = catchOf(b.kind, bp.tier);
  tx.update(pond, "pond", (p) => ({ fish: p.fish + amount, caught: p.caught + amount }));
  tx.update(buildings, b.id, { catches: b.catches + 1, lastCatchAt: Date.now() });
});

export const koiAppears = op((tx) => {
  const now = Date.now();
  tx.insert(koi, { appearedAt: now, escapesAt: now + KOI_LIFETIME_MS });
});

/** What catching a koi pays right now. */
export const koiReward = (perMinute: number) => Math.max(KOI_MIN_REWARD, perMinute);

/**
 * Pays out, then doubles the speed of one random building among the kinds
 * upgraded the most. Boosts stack if the same building is picked again.
 */
export const catchKoi = op((tx, { id }: { id: string }) => {
  if (tx.read(koi.get(id)) === undefined) return;
  const reward = koiReward(tx.read(economy.get("pond"))?.perMinute ?? 0);
  tx.delete(koi, id);
  tx.update(pond, "pond", (p) => ({
    fish: p.fish + reward,
    caught: p.caught + reward,
    koiCaught: p.koiCaught + 1,
  }));

  const tiers = new Map(tx.read(blueprints.all()).map((bp) => [bp.kind, bp.tier]));
  const owned = tx.read(buildings.all());
  const top = Math.max(...owned.map((b) => tiers.get(b.kind) ?? 0));
  const candidates = owned.filter((b) => tiers.get(b.kind) === top);
  if (candidates.length === 0) return;
  tx.update(buildings, pick(candidates).id, (b) => ({ speed: b.speed * 2 }));
});

export const koiEscapes = op((tx, { id }: { id: string }) => {
  if (tx.read(koi.get(id)) !== undefined) tx.delete(koi, id);
});

// --- Effects --------------------------------------------------------------------------

/** Every building fishes in a loop, landing a catch once per cycle. */
export const work = effect({
  inputs: [buildings],
  watch: (q, task) =>
    q.each(
      buildings.all(),
      (b) => {
        const { name, cycleMs } = CATALOG[b.kind];
        task(
          async (ctx) => {
            for (;;) {
              await wait(ctx, "fishing", cycleMs / b.speed);
              ctx.run(landCatch, { buildingId: b.id });
            }
          },
          { label: `${name} #${b.serial}${b.speed > 1 ? ` ⚡×${b.speed}` : ""}` },
        );
      },
      // Landing a catch updates the building's own row, which must not restart
      // it. A koi boost does restart it, at the new speed.
      { rerunOn: ["speed"] },
    ),
});

/** Every 15–40 seconds, a golden koi surfaces. */
export const tide = effect({
  inputs: [pond],
  watch: (q, task) =>
    q.each(
      pond.all(),
      () =>
        task(
          async (ctx) => {
            for (;;) {
              await wait(ctx, "next koi", randomBetween(15_000, 40_000));
              ctx.run(koiAppears, undefined);
            }
          },
          { label: "tide" },
        ),
      // The pond row changes with every catch, which must not restart the tide.
      { rerunOn: [] },
    ),
});

/**
 * Each koi swims off when its time is up. Catching it first deletes the row,
 * which aborts this task.
 */
export const koiTimer = effect({
  inputs: [koi],
  watch: (q, task) =>
    q.each(koi.all(), (k) =>
      task(
        async (ctx) => {
          await wait(ctx, "escaping", Math.max(0, k.escapesAt - Date.now()));
          ctx.run(koiEscapes, { id: k.id });
        },
        { label: `koi ${k.id}` },
      ),
    ),
});

// --- Assembly -------------------------------------------------------------------------

export const game = feature({
  tables: { pond, blueprints, buildings, koi, fleet, economy },
  ops: { newGame, cast, build, upgrade, landCatch, koiAppears, catchKoi, koiEscapes },
  effects: { work, tide, koiTimer },
});

export const db = createDb({
  features: { game },
  introspect: { history: 4 },
  onError: (err, { source }) => console.error(`[${source}]`, err),
});

db.run(newGame, undefined);
