import { ApiProperty } from '@nestjs/swagger';
import { IsPhoneNumber } from 'class-validator';

export class ForgotPasswordDto {
  @ApiProperty({ example: '+201000000002' })
  @IsPhoneNumber()
  phone!: string;
}
