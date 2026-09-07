import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class SendMessageDto {
  @ApiProperty({ example: 'client-msg-001', description: 'Idempotency id from the client' })
  @IsString()
  clientMessageId!: string;

  @ApiProperty({ example: 'text', enum: ['text', 'image', 'voice'] })
  @IsIn(['text', 'image', 'voice'])
  type!: 'text' | 'image' | 'voice';

  @ApiPropertyOptional({ example: 'يلا الملعب الساعة 8' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  text?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  attachmentUrl?: string;

  @ApiPropertyOptional({ example: 'image/jpeg' })
  @IsOptional()
  @IsString()
  attachmentMime?: string;

  @ApiPropertyOptional({ example: 120000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  attachmentSize?: number;

  @ApiPropertyOptional({ example: 15000, description: 'Voice duration in ms' })
  @IsOptional()
  @IsInt()
  @Min(0)
  attachmentDurationMs?: number;
}
