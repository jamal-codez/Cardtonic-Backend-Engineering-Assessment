import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class CreateDepositDto {
  @ApiProperty({ example: 'cNGN', description: 'Case-insensitive coin code' })
  @IsString()
  currency!: string;

  @ApiProperty({ example: '1000.50', description: 'Decimal string, up to 6 decimals' })
  @IsString()
  amount!: string;
}
