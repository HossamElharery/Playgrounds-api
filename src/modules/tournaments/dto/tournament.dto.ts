import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateTournamentDto {
  @ApiPropertyOptional({
    description: 'Venue-hosted, or omit for a virtual/platform-wide tournament',
  })
  @IsOptional()
  @IsString()
  venueId?: string;

  @ApiProperty({
    description: 'A SportCategory id/slug, or a GameCatalogEntry id/slug',
  })
  @IsString()
  activityId!: string;

  @IsString()
  nameEn!: string;

  @IsString()
  nameAr!: string;

  @ApiPropertyOptional({ description: 'Minor currency units' })
  @IsOptional()
  @IsInt()
  @Min(0)
  entryFeeAmount?: number;

  @ApiPropertyOptional({ default: 'EGP' })
  @IsOptional()
  @IsString()
  entryFeeCurrency?: string;

  @ApiProperty({ enum: [8, 16, 32] })
  @IsIn([8, 16, 32])
  maxParticipants!: number;

  @ApiProperty({ example: '2026-09-14T18:00:00.000Z' })
  @IsDateString()
  registrationDeadline!: string;

  @ApiProperty({ example: '2026-09-15T18:00:00.000Z' })
  @IsDateString()
  startsAt!: string;
}

export class ListTournamentsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  activityId?: string;

  @ApiPropertyOptional({
    enum: ['open', 'full', 'in-progress', 'completed', 'cancelled'],
  })
  @IsOptional()
  @IsIn(['open', 'full', 'in-progress', 'completed', 'cancelled'])
  status?: string;

  @ApiPropertyOptional({ description: 'Filter to one venue — e.g. an owner viewing their own tournaments' })
  @IsOptional()
  @IsString()
  venueId?: string;
}

export class ReportMatchResultDto {
  @ApiProperty()
  @IsString()
  winnerId!: string;
}
