import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

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
}
