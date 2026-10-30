import { AppError } from '../errors/app-error';
import { UuidParamPipe } from './uuid-param.pipe';

describe('UuidParamPipe', () => {
  const pipe = new UuidParamPipe();

  it('accepts a UUIDv7 and lower-cases it', () => {
    expect(pipe.transform('01A18E56-7952-729F-AB7D-CB9426C0FD98')).toBe(
      '01a18e56-7952-729f-ab7d-cb9426c0fd98',
    );
  });

  it.each([
    '',
    'not-a-uuid',
    '01a18e56-7952-729f-ab7d-cb9426c0fd9',
    '01a18e56795272 9fab7dcb9426c0fd98',
  ])('rejects %j with VALIDATION_ERROR', (value) => {
    expect(() => pipe.transform(value)).toThrow(AppError);
    try {
      pipe.transform(value);
    } catch (error) {
      expect((error as AppError).code).toBe('VALIDATION_ERROR');
    }
  });
});
