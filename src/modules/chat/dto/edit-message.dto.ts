import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class EditMessageDto {
  @ApiProperty({ example: 'Updated: meet at 8:15 instead' })
  @IsString()
  @MaxLength(4000)
  text!: string;
}
