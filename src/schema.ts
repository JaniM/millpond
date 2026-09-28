import type { StandardSchemaV1 } from "@standard-schema/spec";

/** Any Standard Schema — Zod, Valibot and ArkType all implement it. */
export type Schema = StandardSchemaV1;

/** The row type stored for a table: the schema's output type. */
export type InferRow<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>;

export type { StandardSchemaV1 };
