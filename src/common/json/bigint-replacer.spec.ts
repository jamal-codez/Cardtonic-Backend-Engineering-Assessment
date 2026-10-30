import { bigintReplacer } from './bigint-replacer';

describe('bigintReplacer', () => {
  it('serialises 10n as "10"', () => {
    expect(JSON.stringify({ amount: 10n }, bigintReplacer)).toBe('{"amount":"10"}');
  });

  it('leaves other values untouched', () => {
    expect(JSON.stringify({ a: 1, b: 'x', c: null }, bigintReplacer)).toBe(
      '{"a":1,"b":"x","c":null}',
    );
  });
});
