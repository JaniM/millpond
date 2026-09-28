/**
 * Marks a piece of the public API that is declared but not yet implemented.
 * The scaffold ships the full surface with real types; the engine lands
 * incrementally behind these throws.
 */
export function notImplemented(name: string): never {
  throw new Error(`reactive-db: ${name} is not implemented yet (scaffold).`);
}
