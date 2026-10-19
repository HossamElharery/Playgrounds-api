import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class SendMessageDto {
  @ApiProperty({
    example: 'client-msg-001',
    description: 'Idempotency id from the client',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
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
  @MaxLength(2048)
  attachmentUrl?: string;

  @ApiPropertyOptional({ example: 'image/jpeg' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  attachmentMime?: string;

  @ApiPropertyOptional({ example: 120000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10 * 1024 * 1024)
  attachmentSize?: number;

  @ApiPropertyOptional({ example: 15000, description: 'Voice duration in ms' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10 * 60 * 1000)
  attachmentDurationMs?: number;
}
