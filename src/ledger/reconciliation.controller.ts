import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { AppError } from '../common/errors/app-error';
import { ApiProblems, ApiSuccess } from '../common/http/api-docs';
import { RECONCILIATION_EXAMPLE } from '../docs/examples';
import { toRunResource, type ReconciliationRunResource } from './reconciliation.mapper';
import { ReconciliationService } from './reconciliation.service';
import { isSkipped } from './reconciliation.types';

class RunQueryDto {
  @ApiPropertyOptional({ enum: ['full', 'incremental'], default: 'full' })
  @IsOptional()
  @IsIn(['full', 'incremental'])
  mode?: 'full' | 'incremental';
}

const ADMIN_NOTE =
  'ADMIN endpoint. Unauthenticated in this sandbox: anyone who can reach the API can call it.';

@ApiTags('admin')
@Controller('admin/reconciliation')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get()
  @ApiOperation({ summary: 'Latest reconciliation run', description: ADMIN_NOTE })
  @ApiSuccess(200, 'The latest run', RECONCILIATION_EXAMPLE)
  @ApiProblems('NOT_FOUND')
  async latest(): Promise<ReconciliationRunResource> {
    const run = await this.reconciliation.latest();
    if (!run)
      throw new AppError('NOT_FOUND', { detail: 'No reconciliation run has completed yet' });
    return toRunResource(run);
  }

  @Post('run')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Run a reconciliation now (detects drift, never repairs it)',
    description: `${ADMIN_NOTE} Returns { "skipped": true } when another run is in progress.`,
  })
  @ApiSuccess(
    200,
    'The run, or { "skipped": true } when another run holds the lock',
    RECONCILIATION_EXAMPLE,
  )
  @ApiProblems('VALIDATION_ERROR')
  async run(@Query() query: RunQueryDto): Promise<ReconciliationRunResource | { skipped: true }> {
    const result = await this.reconciliation.run(query.mode ?? 'full');
    return isSkipped(result) ? { skipped: true } : toRunResource(result);
  }
}
