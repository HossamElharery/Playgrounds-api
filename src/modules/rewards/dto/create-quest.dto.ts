import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateQuestDto {
  @ApiProperty({ example: 'weekly_3_bookings' })
  @IsString()
  key!: string;

  @ApiProperty({ example: 'Play 3 times this week' })
  @IsString()
  titleEn!: string;

  @ApiProperty({ example: 'العب 3 مرات هذا الأسبوع' })
  @IsString()
  titleAr!: string;

  @ApiProperty({ example: { target: 3 } })
  @IsObject()
  rule!: Record<string, unknown>;

  @ApiProperty({ example: 150 })
  @IsInt()
  rewardCoins!: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
