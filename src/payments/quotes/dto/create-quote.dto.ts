import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { UUID_PATTERN } from '../../../common/http/uuid-param.pipe';

export class CreateQuoteDto {
  @ApiProperty({
    example: '01a18e56-7952-729f-ab7d-cb9426c0fd98',
    description: 'Wallet the quote is for',
  })
  @IsString()
  @Matches(UUID_PATTERN, { message: 'wallet_id must be a UUID' })
  wallet_id!: string;

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
}
