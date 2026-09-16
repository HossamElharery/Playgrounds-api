import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class RequestEmailRegistrationOtpDto {
  @ApiProperty({ example: 'player@example.com' })
  @IsEmail()
  email!: string;
}
