import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const ACHIEVEMENT_CATEGORIES = ['games', 'matches', 'bookings', 'community'] as const;

export class CreateAchievementDto {
  @ApiProperty({ example: 'penalties_win_10' })
  @IsString()
  key!: string;

  @ApiProperty({
    example: 'game.win.penalties',
    description:
      'What is counted: game.win.<penalties|thief|camo>, game.win, game.played, match.hosted, match.played, booking.completed, review.photo, mvp.awarded, streak.best',
  })
  @IsString()
  metric!: string;

  @ApiProperty({ example: 10 })
  @IsInt()
  @Min(1)
  target!: number;

  @ApiProperty({ example: 80 })
  @IsInt()
  @Min(0)
  @Max(5000)
  rewardCoins!: number;

  @ApiProperty()
  @IsString()
  titleEn!: string;

  @ApiProperty()
  @IsString()
  titleAr!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  descEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  descAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  icon?: string;

  @ApiPropertyOptional({ enum: ACHIEVEMENT_CATEGORIES })
  @IsOptional()
  @IsIn(ACHIEVEMENT_CATEGORIES)
  category?: (typeof ACHIEVEMENT_CATEGORIES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
