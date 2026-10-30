import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import type { Pool } from 'pg';
import { PG_POOL } from '../common/db/database.module';

type CheckStatus = 'up' | 'down';

@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Later phases add their own entries to `checks`. */
  @Get('ready')
  async ready(
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: 'ok' | 'unavailable'; checks: Record<string, CheckStatus> }> {
    const checks: Record<string, CheckStatus> = { database: await this.checkDatabase() };
    const healthy = Object.values(checks).every((status) => status === 'up');
    if (!healthy) {
      res.status(503).setHeader('Retry-After', '1');
    }
    return { status: healthy ? 'ok' : 'unavailable', checks };
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
