import { useMemo } from "react";
import { useOp, useQuery } from "../../src/react";
import { Effects, type Sorts, Tables } from "../inspector";
import {
  blueprints,
  buildings,
  build as buyBuilding,
  CATALOG,
  cast,
  catchKoi,
  catchOf,
  economy,
  fleet,
  KINDS,
  type Kind,
  koi,
  koiReward,
  newGame,
  pond,
  upgrade as upgradeKind,
} from "./db";

const byKind = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  KINDS.indexOf(a.kind as Kind) - KINDS.indexOf(b.kind as Kind);

const SORTS: Sorts = {
  "game.blueprints": byKind,
  "game.fleet": byKind,
  "game.buildings": (a, b) => (a.builtAt as number) - (b.builtAt as number),
};

export function App() {
  return (
    <div className="layout">
      <section className="column main-column">
        <Game />
      </section>
      <section className="column effects-column">
        <Effects />
      </section>
      <section className="column tables-column">
        <Tables sorts={SORTS} />
      </section>
    </div>
  );
}

// --- Game -----------------------------------------------------------------------------

function Game() {
  const reset = useOp(newGame);
  return (
    <>
      <header className="column-header">
        <h1>Millpond</h1>
        <span className="muted">an idle fishing game · every catch is an op</span>
        <a className="muted nav" href="../">
          chat demo →
        </a>
        <button
          type="button"
          onClick={() => {
            if (confirm("Start over? Every fish and building is lost.")) reset();
          }}
        >
          New game
        </button>
      </header>
      <Pond />
      <KoiList />
      <div className="shop">
        <Shop />
      </div>
    </>
  );
}

function Pond() {
  const p = useQuery(pond.get("pond"));
  const eco = useQuery(economy.get("pond"));
  const castLine = useOp(cast);
  if (p === undefined) return null;

  return (
    <div className="pond">
      <div className="pond-count">
        <span className="fish">{formatFish(p.fish)}</span>
        <span className="muted">fish</span>
      </div>
      <div className="muted">{formatRate(eco?.perMinute ?? 0)} per second</div>
      <button type="button" className="primary cast" onClick={() => castLine()}>
        🎣 Cast a line
      </button>
      <div className="muted pond-stats">
        {formatFish(p.caught)} caught in all · {p.casts} casts · {p.koiCaught} golden koi
      </div>
    </div>
  );
}

function KoiList() {
  const swimming = useQuery(koi.all());
  const eco = useQuery(economy.get("pond"));
  const catchIt = useOp(catchKoi);
  const hasBuildings = useQuery(buildings.all()).length > 0;
  if (swimming.length === 0) return null;

  const reward = koiReward(eco?.perMinute ?? 0);
  return (
    <div className="koi-list">
      {swimming.map((k) => (
        <button key={k.id} type="button" className="koi" onClick={() => catchIt({ id: k.id })}>
          <span>
            ✨ A golden koi! Catch it for {formatFish(reward)} fish
            {hasBuildings && " and a speed boost"}
          </span>
          <span className="koi-bar">
            {/* The koi's remaining time, counted down from when it appeared. */}
            <span
              style={{
                animationDuration: `${k.escapesAt - k.appearedAt}ms`,
                animationDelay: `${k.appearedAt - Date.now()}ms`,
              }}
            />
          </span>
        </button>
      ))}
    </div>
  );
}

function Shop() {
  const p = useQuery(pond.get("pond"));
  const all = useQuery(fleet.all());
  const caught = p?.caught ?? 0;
  const sorted = useMemo(() => [...all].sort(byKind), [all]);
  // A kind shows once the player has caught half its price, or owns one.
  // Only the first still-hidden kind is teased.
  const firstHidden = sorted.findIndex(
    (f) => f.owned === 0 && caught < CATALOG[f.kind].baseCost / 2,
  );
  const shown = firstHidden === -1 ? sorted : sorted.slice(0, firstHidden + 1);

  return (
    <>
      {shown.map((f, i) =>
        i === firstHidden ? (
          <div key={f.kind} className="shop-item locked">
            <span className="icon">❓</span>
            <span className="muted">
              Catch {formatFish(CATALOG[f.kind].baseCost / 2)} fish to discover something new
            </span>
          </div>
        ) : (
          <ShopItem key={f.kind} kind={f.kind} />
        ),
      )}
    </>
  );
}

/** How many of a kind's buildings get their own progress bar. */
const MAX_UNITS_SHOWN = 30;

function ShopItem({ kind }: { kind: Kind }) {
  const f = useQuery(fleet.get(kind));
  const bp = useQuery(blueprints.get(kind));
  const fish = useQuery(pond.get("pond"))?.fish ?? 0;
  const units = useQuery(buildings.byKind.kindEq(kind));
  const buy = useOp(buyBuilding);
  const up = useOp(upgradeKind);
  if (f === undefined || bp === undefined) return null;

  const { name, icon, cycleMs } = CATALOG[kind];
  const shown = [...units].sort((a, b) => a.serial - b.serial).slice(0, MAX_UNITS_SHOWN);
  return (
    <div className="shop-item">
      <span className="icon">{icon}</span>
      <div className="shop-info">
        <h2>
          {name}
          {f.owned > 0 && <span className="owned">×{f.owned}</span>}
          {bp.tier > 0 && <span className="badge">tier {bp.tier + 1}</span>}
        </h2>
        <div className="muted">
          {formatFish(catchOf(kind, bp.tier))} fish every {cycleMs / 1000}s
          {f.owned > 0 && ` · ${formatRate(f.perMinute)}/s in all`}
        </div>
        {shown.length > 0 && (
          <div className="units">
            {shown.map((u) => (
              <span
                key={u.id}
                className={`unit${u.speed > 1 ? " boosted" : ""}`}
                title={`${name} #${u.serial}: ${u.catches} catches${u.speed > 1 ? `, ×${u.speed} speed` : ""}`}
              >
                {/* Restarts on each catch, so it roughly tracks the building's task. */}
                <span
                  key={u.lastCatchAt ?? u.builtAt}
                  style={{ animationDuration: `${cycleMs / u.speed}ms` }}
                />
              </span>
            ))}
            {units.length > shown.length && (
              <span className="muted">+{units.length - shown.length}</span>
            )}
          </div>
        )}
      </div>
      <div className="shop-actions">
        <button
          type="button"
          className="primary"
          disabled={fish < f.nextCost}
          onClick={() => buy({ kind })}
        >
          Buy · {formatFish(f.nextCost)}
        </button>
        <button
          type="button"
          disabled={f.owned === 0 || fish < f.upgradeCost}
          onClick={() => up({ kind })}
          title="Doubles the catch of every building of this kind"
        >
          Upgrade ×2 · {formatFish(f.upgradeCost)}
        </button>
      </div>
    </div>
  );
}

// --- Formatting -----------------------------------------------------------------------

const SUFFIXES = ["", "K", "M", "B", "T", "Qa", "Qi"];

function formatFish(n: number): string {
  if (n < 1_000) return String(Math.floor(n));
  const tier = Math.min(Math.floor(Math.log10(n) / 3), SUFFIXES.length - 1);
  return `${(n / 1000 ** tier).toFixed(2)}${SUFFIXES[tier]}`;
}

function formatRate(perMinute: number): string {
  const perSecond = perMinute / 60;
  return perSecond < 1_000 ? perSecond.toFixed(1) : formatFish(perSecond);
}
