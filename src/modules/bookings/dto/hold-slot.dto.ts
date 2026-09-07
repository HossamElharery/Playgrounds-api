import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class HoldSlotDto {
  @ApiProperty({ example: '6ca20f0c-d7a9-4f97-989d-c2f5ac0f8a8f', description: 'Court id from GET /venues/{slug}' })
  @IsString()
  courtId!: string;

  @ApiProperty({
    example: '2026-09-10T18:00:00.000Z',
    description: 'Slot start ISO datetime. Must match a cell from GET /courts/{id}/slots',
  })
  @IsDateString()
  slotStart!: string;

  @ApiPropertyOptional({ example: 1, minimum: 1, maximum: 3, description: 'Number of consecutive 60-min units' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  units?: number;

  @ApiPropertyOptional({ example: 'WELCOME25' })
  @IsOptional()
  @IsString()
  promoCode?: string;

  @ApiPropertyOptional({ example: 0, description: 'Coins to redeem (optional)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  coinsToRedeem?: number;
}
