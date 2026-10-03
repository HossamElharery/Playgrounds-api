import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';

export class UpsertPricingRuleDto {
  @ApiPropertyOptional({ example: 'peak', description: 'A name for the owner only; defaults to "base".' })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiProperty({
    example: [5, 6],
    description: '0=Sunday … 6=Saturday. Empty array = every day',
  })
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  daysOfWeek!: number[];

  @ApiProperty({ example: '17:00' })
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'startTime must be HH:mm' })
  startTime!: string;

  @ApiProperty({ example: '23:00', description: 'Exclusive. "24:00" means until midnight.' })
  @IsString()
  @Matches(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, { message: 'endTime must be HH:mm or 24:00' })
  endTime!: string;

  @ApiProperty({ example: 20000, description: 'Price in piasters (200 EGP = 20000)' })
  @IsInt()
  @Min(0)
  priceAmount!: number;

  @ApiPropertyOptional({ example: 'EGP' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({ example: 1, description: 'Higher wins when rules overlap' })
  @IsOptional()
  @IsInt()
  priority?: number;
}
