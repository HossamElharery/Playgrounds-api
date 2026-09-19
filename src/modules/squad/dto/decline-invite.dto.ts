import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

export class DeclineSquadInviteDto {
  @ApiPropertyOptional({
    description: 'Pause further invites from this sender for five minutes',
  })
  @Transform(({ value }) => value === true || value === 'true' || value === 1 || value === '1')
  @IsOptional()
  @IsBoolean()
  hold?: boolean;
}
