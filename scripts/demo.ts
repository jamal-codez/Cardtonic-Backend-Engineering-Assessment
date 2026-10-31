import { randomUUID } from 'node:crypto';

/**
 * Scripted walkthrough against a running API (`yarn demo`). Each step prints the request, the
 * status, the headers worth seeing and the body, and checks the status it expects: the script
 * exits 1 if the API behaves differently, so it doubles as a smoke test.
 */
const BASE_URL = (process.env['BASE_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');

interface Reply {
  status: number;
  headers: Headers;
  body: unknown;
}

const SHOWN_HEADERS = ['location', 'idempotent-replayed', 'retry-after', 'x-request-id'];
let failures = 0;

async function call(
  step: string,
  expected: number,
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; key?: string } = {},
): Promise<Reply> {
  console.log(`\n=== ${step}`);
  console.log(`> ${method} ${path}`);
  if (options.key) console.log(`> Idempotency-Key: ${options.key}`);
  if (options.body !== undefined) console.log(`> ${JSON.stringify(options.body)}`);

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.key ? { 'idempotency-key': options.key } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep the raw text: the status check below reports it
  }

  const verdict = response.status === expected ? 'ok' : `UNEXPECTED, wanted ${expected}`;
  console.log(`< ${response.status} ${response.statusText} (${verdict})`);
  for (const name of SHOWN_HEADERS) {
    const value = response.headers.get(name);
    if (value) console.log(`< ${name}: ${value}`);
  }
  console.log(JSON.stringify(body, null, 2));
  if (response.status !== expected) failures += 1;
  return { status: response.status, headers: response.headers, body };
}

const field = (value: unknown, ...path: string[]): string => {
  let current = value;
  for (const part of path) current = (current as Record<string, unknown> | undefined)?.[part];
  return String(current);
};

async function main(): Promise<void> {
  console.log(`Operation Borderless demo against ${BASE_URL}`);
  const run = randomUUID().slice(0, 8);

  const a = await call('1a. Create wallet A', 201, 'POST', '/v1/wallets', {
    body: { email: `ada.${run}@example.com` },
  });
  const b = await call('1b. Create wallet B', 201, 'POST', '/v1/wallets', {
    body: { email: `bayo.${run}@example.com` },
  });
  const walletA = field(a.body, 'id');
  const walletB = field(b.body, 'id');

  await call(
    '2. Deposit 1,000,000 cNGN into A (simulated)',
    201,
    'POST',
    `/v1/wallets/${walletA}/deposits`,
    {
      key: randomUUID(),
      body: { currency: 'cNGN', amount: '1000000' },
    },
  );

  await call('3. Swap 100,000 cNGN to USDx', 201, 'POST', `/v1/wallets/${walletA}/swaps`, {
    key: randomUUID(),
    body: { from_currency: 'cNGN', to_currency: 'USDx', amount: '100000' },
  });

  const transferKey = randomUUID();
  const transferBody = {
    to_wallet_id: walletB,
    source_currency: 'cNGN',
    destination_currency: 'cGHS',
    amount: '50000',
  };
  const transfer = await call(
    '4. Cross-currency transfer of 50,000 cNGN from A to B, received as cGHS',
    201,
    'POST',
    `/v1/wallets/${walletA}/transfers`,
    { key: transferKey, body: transferBody },
  );

  const replay = await call(
    '5. Replay the same transfer with the same Idempotency-Key',
    201,
    'POST',
    `/v1/wallets/${walletA}/transfers`,
    { key: transferKey, body: transferBody },
  );
  const replayed = replay.headers.get('idempotent-replayed') === 'true';
  const sameTransaction =
    field(replay.body, 'transaction', 'id') === field(transfer.body, 'transaction', 'id');
  console.log(
    `Idempotent-Replayed header: ${String(replayed)}; same transaction id: ${String(sameTransaction)}`,
  );
  if (!replayed || !sameTransaction) failures += 1;

  const overdraft = await call(
    '6. Overdraft: swap 10,000,000 cNGN from a wallet holding 850,000',
    422,
    'POST',
    `/v1/wallets/${walletA}/swaps`,
    { key: randomUUID(), body: { from_currency: 'cNGN', to_currency: 'USDx', amount: '10000000' } },
  );
  if (field(overdraft.body, 'code') !== 'INSUFFICIENT_FUNDS') failures += 1;

  await call("7a. A's history, newest first", 200, 'GET', `/v1/wallets/${walletA}/transactions`);
  await call('7b. Current rates (simulated feed)', 200, 'GET', '/v1/fx/rates');
  const recon = await call(
    '7c. Reconciliation (admin, unauthenticated)',
    200,
    'POST',
    '/v1/admin/reconciliation/run?mode=full',
  );
  if (field(recon.body, 'ok') !== 'true') failures += 1;

  console.log(
    failures === 0
      ? '\nDemo finished: every step behaved as expected.'
      : `\nDemo finished with ${failures} unexpected result(s).`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
