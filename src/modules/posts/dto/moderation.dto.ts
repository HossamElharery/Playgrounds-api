import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { CursorPaginationQueryDto } from '../../../common/pagination/cursor-pagination.dto';

export class ListModerationReportsQueryDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({ enum: ['open', 'reviewed', 'dismissed'] })
  @IsOptional()
  @IsIn(['open', 'reviewed', 'dismissed'])
  status?: 'open' | 'reviewed' | 'dismissed';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  q?: string;
}

export class ModerationReasonDto {
  @ApiProperty()
  @IsString()
  reason!: string;
}

export class SuspendPostingDto {
  @ApiPropertyOptional({ description: 'null for permanent' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  durationDays?: number | null;

  @ApiProperty()
  @Type(() => Boolean)
  @IsBoolean()
  permanent!: boolean;

  @ApiProperty()
  @IsString()
  reason!: string;
}

export class UpdateCoinsRuleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threshold?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  coinsAwarded?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  active?: boolean;
}

export class UpdateModerationConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  autoHideReportThreshold?: number;
}
