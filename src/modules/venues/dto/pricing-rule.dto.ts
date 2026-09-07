import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class UpsertPricingRuleDto {
  @ApiProperty({ example: 'peak' })
  @IsString()
  label!: string;

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
  startTime!: string;

  @ApiProperty({ example: '23:00' })
  @IsString()
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
