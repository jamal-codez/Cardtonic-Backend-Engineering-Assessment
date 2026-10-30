/** A source of randomness in [0, 1). Injected so tests can use a seeded generator. */
export type Random = () => number;

export const RANDOM = Symbol('RANDOM');
