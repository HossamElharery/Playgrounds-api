import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';
import { NormalizeEmail } from '../../../common/validation/email.transform';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'you@matchena.com' })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
