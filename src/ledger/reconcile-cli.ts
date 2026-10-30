import { Pool } from 'pg';
import { loadConfig } from '../common/config/config';
import { toRunResource } from './reconciliation.mapper';
import { ReconciliationService } from './reconciliation.service';
import { isSkipped } from './reconciliation.types';

/**
 * `yarn reconcile`: one full reconciliation, printed as JSON.
 * Exit codes: 0 ok, 1 drift found, 2 skipped (another run holds the lock), 3 the run itself failed.
 */
async function main(): Promise<number> {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 2 });
  // An idle-connection error would otherwise be an uncaught exception.
  pool.on('error', (error) => console.error(error));
  try {
    const result = await new ReconciliationService(pool, config).run('full');
    if (isSkipped(result)) {
      console.log(JSON.stringify({ skipped: true }, null, 2));
      return 2;
    }
    console.log(JSON.stringify(toRunResource(result), null, 2));
    return result.ok ? 0 : 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 3;
    });
}
