import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateCommentDto {
  @ApiProperty({ example: 'أنا موجود 👍' })
  @IsString()
  @MaxLength(2000)
  text!: string;
}

export class ToggleReactionDto {
  @ApiPropertyOptional({ example: 'fire', enum: ['like', 'fire', 'clap', 'soccer'] })
  @IsOptional()
  @IsIn(['like', 'fire', 'clap', 'soccer'])
  emoji?: string;
}
