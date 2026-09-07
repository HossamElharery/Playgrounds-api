import { ApiProperty } from '@nestjs/swagger';
import { IsPhoneNumber } from 'class-validator';

export class RequestOtpDto {
  @ApiProperty({
    example: '+201001234567',
    description: 'Egyptian mobile in E.164 format. OTP is printed in the server terminal in development.',
  })
  @IsPhoneNumber()
  phone!: string;
}
