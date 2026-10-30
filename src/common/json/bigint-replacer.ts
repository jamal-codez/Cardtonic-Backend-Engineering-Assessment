/**
 * Safety net for Express `json replacer`: a stray bigint becomes a string instead of
 * throwing. Domain code still formats money explicitly.
 */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
