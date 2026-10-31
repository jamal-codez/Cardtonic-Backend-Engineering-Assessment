import { randomUUID } from 'node:crypto';
import autocannon from 'autocannon';

/**
 * Local load test (`yarn load`): mixed deposits and swaps with a unique Idempotency-Key per
 * request, spread over several pre-funded wallets. The numbers depend entirely on the machine and
 * on running against a local Postgres; treat them as indicative only.
 *
 * BASE_URL (default http://localhost:3000), DURATION_S (default 60), CONNECTIONS (default 20),
 * WALLETS (default 20).
 */
const BASE_URL = (process.env['BASE_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
const DURATION_S = Number.parseInt(process.env['DURATION_S'] ?? '60', 10);
const CONNECTIONS = Number.parseInt(process.env['CONNECTIONS'] ?? '20', 10);
const WALLETS = Number.parseInt(process.env['WALLETS'] ?? '20', 10);

async function post(path: string, body: unknown, key?: string): Promise<{ id?: string }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as { id?: string };
}

async function main(): Promise<void> {
  const run = randomUUID().slice(0, 8);
  console.log(`Preparing ${WALLETS} wallets against ${BASE_URL}`);
  const wallets: string[] = [];
  for (let i = 0; i < WALLETS; i += 1) {
    const wallet = await post('/v1/wallets', { email: `load.${run}.${i}@example.com` });
    if (!wallet.id) throw new Error('wallet without an id');
    // Large enough that the swaps in one run never run a wallet dry (the limit is 1,000,000,000).
    await post(
      `/v1/wallets/${wallet.id}/deposits`,
      { currency: 'cNGN', amount: '900000000' },
      `${run}-fund-${i}`,
    );
    wallets.push(wallet.id);
  }

  const json = { 'content-type': 'application/json' };
  const requests = wallets.flatMap((id) => [
    {
      method: 'POST' as const,
      path: `/v1/wallets/${id}/deposits`,
      headers: { ...json, 'idempotency-key': `${run}-dep-[<id>]` },
      body: JSON.stringify({ currency: 'cNGN', amount: '100' }),
    },
    {
      method: 'POST' as const,
      path: `/v1/wallets/${id}/swaps`,
      headers: { ...json, 'idempotency-key': `${run}-swap-[<id>]` },
      body: JSON.stringify({ from_currency: 'cNGN', to_currency: 'USDx', amount: '1000' }),
    },
  ]);

  console.log(`Running ${DURATION_S}s, ${CONNECTIONS} connections, deposits and swaps alternating`);
  const result = await autocannon({
    url: BASE_URL,
    connections: CONNECTIONS,
    duration: DURATION_S,
    requests,
    idReplacement: true,
  });

  const summary = {
    duration_s: DURATION_S,
    connections: CONNECTIONS,
    wallets: WALLETS,
    requests_total: result.requests.total,
    requests_per_second_avg: result.requests.average,
    latency_ms: {
      p50: result.latency.p50,
      p97_5: result.latency.p97_5,
      p99: result.latency.p99,
      max: result.latency.max,
    },
    status_2xx: result['2xx'],
    non_2xx: result.non2xx,
    errors: result.errors,
    timeouts: result.timeouts,
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(result.errors > 0 || result.non2xx > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
