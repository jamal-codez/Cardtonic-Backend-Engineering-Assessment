import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import type { Pool } from 'pg';
import { PG_POOL } from '../common/db/database.module';
import { RateService } from '../fx/rate.service';

type CheckStatus = 'up' | 'down';

interface FxCheck {
  loaded: boolean;
  source: string | null;
  as_of: string | null;
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
    const fx = this.checkFx();
    const checks = { database: await this.checkDatabase(), fx };
    const healthy = checks.database === 'up' && fx.loaded;
    if (!healthy) {
      res.status(503).setHeader('Retry-After', '1');
    }
    return { status: healthy ? 'ok' : 'unavailable', checks };
  }

  private checkFx(): FxCheck {
    const status = this.rates.status();
    return {
      loaded: status.loaded,
      source: status.source,
      as_of: status.asOf?.toISOString() ?? null,
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
