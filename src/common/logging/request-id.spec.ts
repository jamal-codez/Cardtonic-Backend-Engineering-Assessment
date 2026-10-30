import { resolveRequestId } from './request-id';

describe('resolveRequestId', () => {
  it('keeps a valid incoming id', () => {
    expect(resolveRequestId('abc-123_XYZ')).toBe('abc-123_XYZ');
  });

  it.each([undefined, '', 'has space', 'tab\there', 'x'.repeat(129), 'café'])(
    'generates a UUIDv7 for an invalid id (%j)',
    (value) => {
      expect(resolveRequestId(value)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    },
  );

  it('accepts a 128 character id', () => {
    const id = 'a'.repeat(128);
    expect(resolveRequestId(id)).toBe(id);
  });
});
