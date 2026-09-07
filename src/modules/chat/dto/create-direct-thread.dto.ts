import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class CreateDirectThreadDto {
  @ApiProperty({ example: 'other-user-uuid' })
  @IsString()
  participantId!: string;
}
