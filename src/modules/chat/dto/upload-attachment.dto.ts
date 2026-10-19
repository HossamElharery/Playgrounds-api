import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNumberString, IsOptional, IsString, MaxLength } from 'class-validator';

export class UploadAttachmentDto {
  @ApiPropertyOptional({ description: 'Client-generated idempotency id for the message' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  clientMessageId?: string;

  @ApiPropertyOptional({ enum: ['image', 'voice'], default: 'image' })
  @IsOptional()
  @IsIn(['image', 'voice'])
  type?: 'image' | 'voice';

  @ApiPropertyOptional({ description: 'Voice-note duration in milliseconds (numeric string)' })
  @IsOptional()
  @IsNumberString()
  durationMs?: string;
}
