import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class SendFriendRequestDto {
  @ApiProperty({ example: 'player-user-uuid' })
  @IsString()
  addresseeId!: string;
}
