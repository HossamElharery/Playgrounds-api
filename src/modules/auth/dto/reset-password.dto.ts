import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, MinLength } from 'class-validator';
import { ForgotPasswordDto } from './forgot-password.dto';

export class ResetPasswordDto extends ForgotPasswordDto {
  @ApiProperty({ example: '1234', description: '4-digit OTP from the server console' })
  @IsString()
  @Length(4, 4)
  code!: string;

  @ApiProperty({ example: 'NewPassword123!' })
  @IsString()
  @MinLength(8)
  newPassword!: string;
}
