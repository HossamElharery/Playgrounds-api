import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class UpdatePostDto {
  @ApiProperty()
  @IsString()
  @MaxLength(2200)
  text!: string;
}
