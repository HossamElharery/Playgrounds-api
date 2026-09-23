import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class GlobalSearchDto {
  @ApiProperty({ example: 'بادل', description: 'Free-text query across venues, players, teams, matches, tournaments.' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  q!: string;

  @ApiPropertyOptional({ example: 5, minimum: 1, maximum: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  limit?: number;
}
