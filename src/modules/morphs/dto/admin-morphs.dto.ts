import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MORPH_ID_MAX_LENGTH, MORPH_ID_PATTERN } from './morph-id.validation';

export class GrantMorphDto {
  @ApiProperty()
  @IsUUID()
  userId!: string;

  @ApiProperty({ example: 'golden_pharaoh' })
  @IsString()
  @MaxLength(MORPH_ID_MAX_LENGTH)
  @Matches(MORPH_ID_PATTERN)
  morphId!: string;
}

export class MorphStatsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 90, default: 7 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;
}
