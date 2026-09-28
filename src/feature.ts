import type { Effect } from "./effect";
import { notImplemented } from "./internal";
import type { Op } from "./op";
import type { Table } from "./table";

/**
 * A feature groups definitions under named keys. A definition's registered
 * name is the feature key plus its key here (e.g. `chat.send`).
 */
export interface Feature<
  Tables extends Record<string, Table> = Record<string, Table>,
  Ops extends Record<string, Op> = Record<string, Op>,
  Effects extends Record<string, Effect> = Record<string, Effect>,
> {
  readonly kind: "feature";
  /** Phantom maps of the registered definitions; not present at runtime. */
  readonly __tables?: Tables;
  readonly __ops?: Ops;
  readonly __effects?: Effects;
}

export interface FeatureConfig<
  Tables extends Record<string, Table>,
  Ops extends Record<string, Op>,
  Effects extends Record<string, Effect>,
> {
  tables?: Tables;
  ops?: Ops;
  effects?: Effects;
}

export function feature<
  Tables extends Record<string, Table> = Record<string, Table>,
  Ops extends Record<string, Op> = Record<string, Op>,
  Effects extends Record<string, Effect> = Record<string, Effect>,
>(config: FeatureConfig<Tables, Ops, Effects>): Feature<Tables, Ops, Effects> {
  void config;
  return notImplemented("feature()");
}
