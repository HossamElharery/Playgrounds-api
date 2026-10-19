import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { MESSAGE_POLICIES } from '../../chat/message-policy';

export class UpdatePrivacyDto {
  @ApiPropertyOptional({
    example: 'everyone',
    enum: [...MESSAGE_POLICIES],
  })
  @IsOptional()
  @IsIn([...MESSAGE_POLICIES])
  messagePolicy?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  lastSeenVisible?: boolean;
}
