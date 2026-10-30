import { formatAmount, parseAmount } from '../common/money/money';
import { parseCurrency } from '../common/money/currency';
import { canonicalJson, hashRequest } from './request-hash';

const SCOPE = 'wallet:w1:POST /v1/wallets/:id/deposits';

function normalisedBody(currency: string, amount: string) {
  return { currency: parseCurrency(currency), amount: formatAmount(parseAmount(amount)) };
}

describe('request hash', () => {
  it('ignores object key order, at any depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ y: 1, x: 2 }] } })).toBe(
      canonicalJson({ a: { c: [{ x: 2, y: 1 }], d: 2 }, b: 1 }),
    );
    expect(hashRequest(SCOPE, { amount: '1.000000', currency: 'cNGN' })).toBe(
      hashRequest(SCOPE, { currency: 'cNGN', amount: '1.000000' }),
    );
  });

  it('ignores amount formatting and currency case once the body is normalised', () => {
    expect(hashRequest(SCOPE, normalisedBody('cngn', '10'))).toBe(
      hashRequest(SCOPE, normalisedBody('cNGN', '10.000000')),
    );
    expect(hashRequest(SCOPE, normalisedBody('cNGN', '10.0'))).toBe(
      hashRequest(SCOPE, normalisedBody('CNGN', '10')),
    );
  });

  it('changes when the amount, currency or scope changes', () => {
    const base = hashRequest(SCOPE, normalisedBody('cNGN', '10'));
    expect(hashRequest(SCOPE, normalisedBody('cNGN', '10.000001'))).not.toBe(base);
    expect(hashRequest(SCOPE, normalisedBody('USDx', '10'))).not.toBe(base);
    expect(
      hashRequest('wallet:w2:POST /v1/wallets/:id/deposits', normalisedBody('cNGN', '10')),
    ).not.toBe(base);
  });

  it('refuses values it cannot hash instead of colliding silently', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
  });

  it('is a 64 character hex digest', () => {
    expect(hashRequest(SCOPE, {})).toMatch(/^[0-9a-f]{64}$/);
  });
});
