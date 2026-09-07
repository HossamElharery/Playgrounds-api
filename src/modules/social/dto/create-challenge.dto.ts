import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString } from 'class-validator';

export class CreateChallengeDto {
  @ApiProperty({ example: 'other-team-uuid' })
  @IsString()
  challengedTeamId!: string;

  @ApiPropertyOptional({ example: '2026-09-20T19:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  proposedDateTime?: string;
}
