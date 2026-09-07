import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';

export class UpdatePrivacyDto {
  @ApiPropertyOptional({
    example: 'everyone',
    enum: ['everyone', 'friends', 'teammates', 'nobody'],
  })
  @IsOptional()
  @IsIn(['everyone', 'friends', 'teammates', 'nobody'])
  messagePolicy?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  lastSeenVisible?: boolean;
}
