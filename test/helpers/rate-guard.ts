import type { TestApp } from './create-test-app';

export interface RateGuard {
  /** How many calls to `getRate` the guard has seen. */
  readonly rateCalls: number;
  /** How many transactions the guard has seen opened. */
  readonly transactionsOpened: number;
  restore(): void;
}

/**
 * Enforces "resolve FX rates before BEGIN": while any `TransactionRunner.run` is in progress,
 * `RateService.getRate` throws. Install it in a test, run the scenario, then `restore()`.
 */
export function guardRatesOutsideTransactions(t: TestApp): RateGuard {
  let open = 0;
  let rateCalls = 0;
  let transactionsOpened = 0;

  const realRun = t.transactions.run.bind(t.transactions);
  const realGetRate = t.rates.getRate.bind(t.rates);

  const runSpy = jest.spyOn(t.transactions, 'run').mockImplementation(async (fn, options) => {
    open += 1;
    transactionsOpened += 1;
    try {
      return await realRun(fn, options);
    } finally {
      open -= 1;
    }
  });

  const rateSpy = jest.spyOn(t.rates, 'getRate').mockImplementation((from, to) => {
    rateCalls += 1;
    if (open > 0) {
      throw new Error('RateService.getRate was called while a database transaction was open');
    }
    return realGetRate(from, to);
  });

  return {
    get rateCalls() {
      return rateCalls;
    },
    get transactionsOpened() {
      return transactionsOpened;
    },
    restore() {
      runSpy.mockRestore();
      rateSpy.mockRestore();
    },
  };
}
