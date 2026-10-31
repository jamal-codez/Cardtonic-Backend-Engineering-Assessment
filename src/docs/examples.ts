/**
 * Example response bodies shown in the OpenAPI document. They are plain data so that an
 * integration test can check their shape against real responses (test/docs-examples.int-spec.ts):
 * an example whose keys drift from the API fails the build.
 */

const WALLET_ID = '019a1c52-3f10-7a31-8d52-0c4e6f1b2a90';
const OTHER_WALLET_ID = '019a1c52-3f2b-7c04-9e17-5b8d2a6c4f31';
const TRANSACTION_ID = '019a1c52-4a7e-7b6d-8f20-1d9c3e5a7b42';
const QUOTE_ID = '019a1c52-5b81-7d93-a4c6-2e0f8b1d6c53';
const AT = '2026-01-01T00:00:00.000Z';

const BALANCES = [
  { currency: 'cNGN', amount: '900000.000000' },
  { currency: 'cGHS', amount: '0.000000' },
  { currency: 'cXAF', amount: '0.000000' },
  { currency: 'USDx', amount: '66.666666' },
  { currency: 'EURx', amount: '0.000000' },
];

export const WALLET_EXAMPLE = {
  id: WALLET_ID,
  email: 'ada@example.com',
  phone: null,
  status: 'active',
  created_at: AT,
  balances: BALANCES,
  total_usd: { amount: '66.66', rates_as_of: AT, source: 'simulated', indicative: true },
};

export const DEPOSIT_EXAMPLE = {
  transaction: {
    id: TRANSACTION_ID,
    type: 'deposit',
    source_currency: 'cNGN',
    source_amount: '1000000.000000',
    dest_currency: 'cNGN',
    dest_amount: '1000000.000000',
    created_at: AT,
  },
  balances_after: BALANCES,
};

export const SWAP_EXAMPLE = {
  transaction: {
    id: TRANSACTION_ID,
    type: 'swap',
    source_currency: 'cNGN',
    source_amount: '100000.000000',
    dest_currency: 'USDx',
    dest_amount: '66.666666',
    rate: '0.000666666666',
    rate_source: 'simulated',
    rate_as_of: AT,
    created_at: AT,
  },
  balances_after: BALANCES,
};

export const TRANSFER_EXAMPLE = {
  transaction: {
    id: TRANSACTION_ID,
    type: 'transfer',
    sender_wallet_id: WALLET_ID,
    receiver_wallet_id: OTHER_WALLET_ID,
    source_currency: 'cNGN',
    source_amount: '50000.000000',
    dest_currency: 'cGHS',
    dest_amount: '500.000000',
    rate: '0.010000000000',
    rate_source: 'simulated',
    rate_as_of: AT,
    created_at: AT,
  },
  balances_after: BALANCES,
};

export const QUOTE_EXAMPLE = {
  quote_id: QUOTE_ID,
  rate: '0.000666666666',
  source_amount: '1500.000000',
  destination_amount: '0.999999',
  source: 'simulated',
  expires_at: '2026-01-01T00:00:30.000Z',
};

export const RATES_EXAMPLE = {
  base: 'USD',
  provider: 'simulated',
  source: 'simulated',
  as_of: AT,
  refreshed_at: AT,
  rates: [
    { from: 'cNGN', to: 'cGHS', rate: '0.010000000000', source: 'simulated', refreshed_at: AT },
    { from: 'cNGN', to: 'USDx', rate: '0.000666666666', source: 'simulated', refreshed_at: AT },
  ],
};

export const HISTORY_EXAMPLE = {
  data: [
    {
      transaction_id: TRANSACTION_ID,
      type: 'swap',
      currency_out: 'cNGN',
      amount_out: '100000.000000',
      currency_in: 'USDx',
      amount_in: '66.666666',
      counterparty_wallet_id: null,
      rate: '0.000666666666',
      rate_source: 'simulated',
      created_at: AT,
    },
  ],
  next_cursor: null,
};

export const TRANSACTION_DETAIL_EXAMPLE = {
  id: TRANSACTION_ID,
  type: 'swap',
  status: 'completed',
  initiator_wallet_id: WALLET_ID,
  counterparty_wallet_id: null,
  source_currency: 'cNGN',
  source_amount: '100000.000000',
  dest_currency: 'USDx',
  dest_amount: '66.666666',
  rate: '0.000666666666',
  rate_source: 'simulated',
  rate_as_of: AT,
  created_at: AT,
  entries: [
    { account_kind: 'user', wallet_id: WALLET_ID, currency: 'cNGN', amount: '-100000.000000' },
    { account_kind: 'fx_pool', wallet_id: null, currency: 'cNGN', amount: '100000.000000' },
    { account_kind: 'fx_pool', wallet_id: null, currency: 'USDx', amount: '-66.666666' },
    { account_kind: 'user', wallet_id: WALLET_ID, currency: 'USDx', amount: '66.666666' },
  ],
};

export const RECONCILIATION_EXAMPLE = {
  id: '019a1c52-6c92-7e04-b5d7-3f1a9c2e7d64',
  mode: 'full',
  started_at: AT,
  finished_at: AT,
  window_from: null,
  accounts_checked: 10,
  ok: true,
  drift: [] as unknown[],
  currency_net: {
    cNGN: '0.000000',
    cGHS: '0.000000',
    cXAF: '0.000000',
    USDx: '0.000000',
    EURx: '0.000000',
  },
  unbalanced_transactions: [] as unknown[],
};

export const PROBLEM_EXAMPLE = {
  type: 'urn:problem:insufficient-funds',
  title: 'Insufficient funds',
  status: 422,
  detail: 'The wallet balance is too low for this amount',
  code: 'INSUFFICIENT_FUNDS',
  request_id: '019a1c52-7da3-7f15-8c68-4a2b0d3f8e75',
};

export const VALIDATION_PROBLEM_EXAMPLE = {
  type: 'urn:problem:validation-error',
  title: 'Validation error',
  status: 400,
  detail: 'Request validation failed',
  code: 'VALIDATION_ERROR',
  request_id: '019a1c52-7da3-7f15-8c68-4a2b0d3f8e75',
  errors: [{ field: 'amount', message: 'amount must be a decimal string' }],
};
