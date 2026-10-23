import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateAchievementDto } from './create-achievement.dto';

/** `key` never changes: it is part of every player's reward reference. */
export class UpdateAchievementDto extends PartialType(OmitType(CreateAchievementDto, ['key'] as const)) {}
