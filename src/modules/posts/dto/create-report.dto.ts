import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const POST_REPORT_REASONS = [
  'spam',
  'inappropriate',
  'copyright',
  'harassment',
  'misinformation',
  'other',
] as const;

export class CreatePostReportDto {
  @ApiProperty({ enum: POST_REPORT_REASONS })
  @IsIn(POST_REPORT_REASONS)
  reason!: (typeof POST_REPORT_REASONS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
