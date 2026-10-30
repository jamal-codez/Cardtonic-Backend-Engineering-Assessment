import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, ValidateIf } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateWalletDto {
  @ApiPropertyOptional({ example: 'ada@example.com' })
  // Only a missing field is optional: null must fail validation rather than reach the service.
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({ example: '08031234567', description: 'Parsed with region NG by default' })
  // Only a missing field is optional: null must fail validation rather than reach the service.
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  phone?: string;
}
