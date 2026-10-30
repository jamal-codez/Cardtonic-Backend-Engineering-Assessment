import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';

export const ACTIVITY_TYPES = ['deposit', 'swap', 'transfer_in', 'transfer_out'] as const;
export type ActivityTypeFilter = (typeof ACTIVITY_TYPES)[number];

/** Query parameters arrive as strings; limit is parsed explicitly (see HistoryService). */
export class HistoryQueryDto {
  @ApiPropertyOptional({ enum: ACTIVITY_TYPES })
  @IsOptional()
  @IsIn(ACTIVITY_TYPES)
  type?: ActivityTypeFilter;

  @ApiPropertyOptional({ example: 'cNGN', description: 'Matches either side of the activity' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({ example: '20', description: 'Integer from 1 to 100, default 20' })
  @IsOptional()
  @Matches(/^[0-9]{1,3}$/, { message: 'limit must be an integer between 1 and 100' })
  limit?: string;

  @ApiPropertyOptional({ description: 'Opaque value from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;
}
