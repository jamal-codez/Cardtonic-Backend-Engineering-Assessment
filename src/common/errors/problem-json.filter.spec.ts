import { ArgumentsHost, NotFoundException } from '@nestjs/common';
import { AppError } from './app-error';
import { ProblemJsonFilter } from './problem-json.filter';

function makeHost(requestId = 'req-123') {
  const headers: Record<string, string> = {};
  const sent: { status?: number; type?: string; body?: string } = {};
  const res = {
    getHeader: () => undefined,
    setHeader: (key: string, value: string) => {
      headers[key] = value;
    },
    status(code: number) {
      sent.status = code;
      return this;
    },
    type(contentType: string) {
      sent.type = contentType;
      return this;
    },
    send(body: string) {
      sent.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({ getRequest: () => ({ id: requestId }), getResponse: () => res }),
  } as unknown as ArgumentsHost;
  return { host, sent, headers };
}

describe('ProblemJsonFilter', () => {
  const filter = new ProblemJsonFilter();

  beforeEach(() => {
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
  });

  it('maps an AppError to the right status, code, content-type and request_id', () => {
    const { host, sent } = makeHost('abc');
    filter.catch(new AppError('INSUFFICIENT_FUNDS', { detail: 'not enough' }), host);
    expect(sent.status).toBe(422);
    expect(sent.type).toBe('application/problem+json');
    expect(JSON.parse(sent.body ?? '{}')).toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      status: 422,
      detail: 'not enough',
      request_id: 'abc',
    });
  });

  it('sets Retry-After on a 503', () => {
    const { host, sent, headers } = makeHost();
    filter.catch(new AppError('RETRY_LATER', { retryAfterSeconds: 1 }), host);
    expect(sent.status).toBe(503);
    expect(headers['Retry-After']).toBe('1');
  });

  it('includes field errors for validation failures', () => {
    const { host, sent } = makeHost();
    filter.catch(
      new AppError('VALIDATION_ERROR', {
        errors: [{ field: 'email', message: 'must be an email' }],
      }),
      host,
    );
    expect(JSON.parse(sent.body ?? '{}')).toMatchObject({
      errors: [{ field: 'email', message: 'must be an email' }],
    });
  });

  it('maps a Nest NotFoundException to a 404 problem', () => {
    const { host, sent } = makeHost();
    filter.catch(new NotFoundException('Cannot GET /nope'), host);
    expect(sent.status).toBe(404);
    expect(JSON.parse(sent.body ?? '{}')).toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each([
    ['57014', 503, 'RETRY_LATER'],
    ['22003', 422, 'AMOUNT_LIMIT_EXCEEDED'],
  ])('maps a raw pg error %s to %i %s', (pgCode, status, code) => {
    const { host, sent } = makeHost();
    filter.catch(Object.assign(new Error('pg'), { code: pgCode }), host);
    expect(sent.status).toBe(status);
    expect(JSON.parse(sent.body ?? '{}')).toMatchObject({ code });
  });

  it('answers 503 RETRY_LATER when the database connection fails', () => {
    const { host, sent, headers } = makeHost();
    filter.catch(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }), host);
    expect(sent.status).toBe(503);
    expect(headers['Retry-After']).toBe('1');
  });

  it('never logs the bound parameters of a wrapped database error (no raw email or phone)', () => {
    const { host } = makeHost();
    const logSpy = jest.spyOn(filter['logger'], 'error');
    const driverError = Object.assign(new Error('statement timeout'), { code: '57014' });
    const wrapper = Object.assign(
      new Error('Failed query: insert into wallets\nparams: ada@example.com,+2348031234567'),
      {
        query: 'insert into wallets (email) values ($1)',
        params: ['ada@example.com', '+2348031234567'],
        cause: driverError,
      },
    );

    filter.catch(wrapper, host);

    const logged = JSON.stringify(logSpy.mock.calls);
    expect(logged).not.toContain('ada@example.com');
    expect(logged).not.toContain('+2348031234567');
    expect(logged).toContain('57014');
  });

  it('hides unknown error details behind INTERNAL_ERROR', () => {
    const { host, sent } = makeHost();
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
    filter.catch(new Error('secret stack info'), host);
    expect(sent.status).toBe(500);
    expect(sent.body).not.toContain('secret');
    expect(JSON.parse(sent.body ?? '{}')).toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});
