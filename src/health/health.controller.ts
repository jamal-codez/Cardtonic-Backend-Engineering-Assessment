import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import type { Pool } from 'pg';
import { PG_POOL } from '../common/db/database.module';
import { RateService } from '../fx/rate.service';

type CheckStatus = 'up' | 'down';

interface FxCheck {
  provider: string;
  source: string | null;
  as_of: string | null;
  /** Present only while the most recent refresh failed or was rejected. */
  last_error?: string;
}

export interface ReadinessBody {
  status: 'ok' | 'unavailable';
  checks: { database: CheckStatus; fx: FxCheck };
}

@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly rates: RateService,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Later phases add their own entries to `checks`. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessBody> {
    // A failing or rejected refresh never makes the service unready: it keeps serving the last
    // good rates. Only "no rates at all" would, and boot guarantees a set before it listens.
    const loaded = this.rates.status().loaded;
    const fx = this.checkFx();
    const checks = { database: await this.checkDatabase(), fx };
    const healthy = checks.database === 'up' && loaded;
    if (!healthy) {
      res.status(503).setHeader('Retry-After', '1');
    }
    return { status: healthy ? 'ok' : 'unavailable', checks };
  }

  private checkFx(): FxCheck {
    const status = this.rates.status();
    return {
      provider: status.provider,
      source: status.source,
      as_of: status.asOf?.toISOString() ?? null,
      ...(status.lastError ? { last_error: status.lastError } : {}),
    };
  }

  private async checkDatabase(): Promise<CheckStatus> {
    try {
      await this.pool.query('SELECT 1');
      return 'up';
    } catch {
      return 'down';
    }
  }
}
