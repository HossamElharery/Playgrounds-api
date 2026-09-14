import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsObject, IsOptional, IsString } from 'class-validator';

export class UpdateQuestDto {
  @ApiPropertyOptional({ example: 'Play 3 times this week' })
  @IsOptional()
  @IsString()
  titleEn?: string;

  @ApiPropertyOptional({ example: 'العب 3 مرات هذا الأسبوع' })
  @IsOptional()
  @IsString()
  titleAr?: string;

  @ApiPropertyOptional({
    example: { target: 3, event: 'booking.completed', scope: { activityKind: 'gaming-station' } },
    description:
      'MAL3AB_ENGAGEMENT_ENGINE_BLUEPRINT.md §3 — target count, which event bumps it, and an optional scope (activityKind and/or activityId). Omit scope to apply to every activity.',
  })
  @IsOptional()
  @IsObject()
  rule?: Record<string, unknown>;

  @ApiPropertyOptional({ example: 150 })
  @IsOptional()
  @IsInt()
  rewardCoins?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
