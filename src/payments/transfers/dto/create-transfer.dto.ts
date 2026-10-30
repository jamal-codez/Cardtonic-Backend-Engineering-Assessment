import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, Matches, ValidateIf } from 'class-validator';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CreateTransferDto {
  @ApiProperty({
    example: '01a18e56-7952-729f-ab7d-cb9426c0fd98',
    description: 'Recipient wallet id',
  })
  @IsString()
  @Matches(UUID_PATTERN, { message: 'to_wallet_id must be a UUID' })
  to_wallet_id!: string;

  @ApiProperty({ example: 'cNGN', description: 'Coin the sender pays in (case-insensitive)' })
  @IsString()
  source_currency!: string;

  @ApiPropertyOptional({
    example: 'cGHS',
    description: 'Coin the recipient receives; defaults to source_currency',
  })
  // Only a missing field is optional: null must fail validation rather than reach the service.
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  destination_currency?: string;

  @ApiProperty({
    example: '1500',
    description: 'Exact amount of source_currency to send: decimal string, up to 6 decimals',
  })
  @IsString()
  amount!: string;
}
