import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class InviteToSquadDto {
  @ApiProperty({ example: 'other-user-uuid' })
  @IsString()
  toUserId!: string;
}
