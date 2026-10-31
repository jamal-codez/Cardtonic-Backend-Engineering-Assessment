import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, Matches, ValidateIf } from 'class-validator';
import { UUID_PATTERN } from '../../../common/http/uuid-param.pipe';

export class CreateSwapDto {
  @ApiProperty({ example: 'cNGN', description: 'Coin being sold (case-insensitive)' })
  @IsString()
  from_currency!: string;

  @ApiProperty({ example: 'USDx', description: 'Coin being bought (case-insensitive)' })
  @IsString()
  to_currency!: string;

  @ApiProperty({
    example: '1500',
    description: 'Exact amount of from_currency to sell: decimal string, up to 6 decimals',
  })
  @IsString()
  amount!: string;

  @ApiPropertyOptional({
    example: '01a18e56-7952-729f-ab7d-cb9426c0fd98',
    description: 'Execute at the rate locked by POST /v1/fx/quotes (single use, short-lived)',
  })
  // Only a missing field is optional: null must fail validation rather than reach the service.
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(UUID_PATTERN, { message: 'quote_id must be a UUID' })
  quote_id?: string;
}
