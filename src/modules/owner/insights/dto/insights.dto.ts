import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class OccupancyQueryDto {
  @ApiProperty()
  @IsUUID()
  venueId!: string;

  @ApiPropertyOptional({ minimum: 4, maximum: 12, default: 8 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(4)
  @Max(12)
  weeks?: number;
}

export class WindowDto {
  @ApiProperty()
  @IsUUID()
  venueId!: string;

  @ApiProperty()
  @IsUUID()
  courtId!: string;

  @ApiProperty({ description: '0 = Sunday … 6 = Saturday (venue-local)' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6)
  weekday!: number;

  @ApiProperty({ minimum: 0, maximum: 23 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(23)
  startHour!: number;

  @ApiProperty({ minimum: 1, maximum: 24, description: 'Exclusive' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  endHour!: number;
}

export class ApplyDiscountDto extends WindowDto {
  @ApiProperty({ minimum: 5, maximum: 50 })
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(50)
  percent!: number;

  @ApiProperty({ minimum: 1, maximum: 12 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  weeks!: number;

  @ApiPropertyOptional({ enum: ['suggestion', 'manual'] })
  @IsOptional()
  @IsIn(['suggestion', 'manual'])
  source?: 'suggestion' | 'manual';
}
