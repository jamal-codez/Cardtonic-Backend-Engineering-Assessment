export const ERROR_CATALOGUE = {
  VALIDATION_ERROR: { status: 400, title: 'Validation error' },
  IDEMPOTENCY_KEY_REQUIRED: { status: 400, title: 'Idempotency-Key header is required' },
  IDEMPOTENCY_KEY_INVALID: { status: 400, title: 'Idempotency-Key header is invalid' },
  UNSUPPORTED_CURRENCY: { status: 400, title: 'Unsupported currency' },
  SAME_CURRENCY_SWAP: { status: 400, title: 'Cannot swap a currency for itself' },
  SELF_TRANSFER: { status: 400, title: 'Cannot transfer to the same wallet' },
  INVALID_CURSOR: { status: 400, title: 'Invalid pagination cursor' },
  WALLET_NOT_FOUND: { status: 404, title: 'Wallet not found' },
  RECIPIENT_NOT_FOUND: { status: 404, title: 'Recipient not found' },
  TRANSACTION_NOT_FOUND: { status: 404, title: 'Transaction not found' },
  QUOTE_NOT_FOUND: { status: 404, title: 'Quote not found' },
  WALLET_ALREADY_EXISTS: { status: 409, title: 'Wallet already exists' },
  INSUFFICIENT_FUNDS: { status: 422, title: 'Insufficient funds' },
  AMOUNT_TOO_SMALL: { status: 422, title: 'Amount too small' },
  AMOUNT_LIMIT_EXCEEDED: { status: 422, title: 'Amount limit exceeded' },
  IDEMPOTENCY_KEY_REUSED: { status: 422, title: 'Idempotency-Key reused with a different request' },
  WALLET_FROZEN: { status: 422, title: 'Wallet is frozen' },
  QUOTE_EXPIRED: { status: 422, title: 'Quote expired' },
  QUOTE_USED: { status: 422, title: 'Quote already used' },
  QUOTE_MISMATCH: { status: 422, title: 'Quote does not match the request' },
  FX_UNAVAILABLE: { status: 503, title: 'FX rates unavailable' },
  RETRY_LATER: { status: 503, title: 'Temporarily unavailable, retry later' },
  INTERNAL_ERROR: { status: 500, title: 'Internal error' },
  // Transport-level codes outside the domain catalogue (see docs/decisions.md).
  NOT_FOUND: { status: 404, title: 'Route not found' },
  METHOD_NOT_ALLOWED: { status: 405, title: 'Method not allowed' },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'Request body too large' },
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOGUE;

export interface FieldError {
  field: string;
  message: string;
}
