import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class OwnerReplyDto {
  @ApiProperty({ example: 'Thanks for playing with us — see you next week!' })
  @IsString()
  text!: string;
}
