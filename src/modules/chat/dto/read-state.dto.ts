import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class ReadStateDto {
  @ApiProperty({ example: 'last-message-uuid' })
  @IsString()
  lastReadMessageId!: string;
}
