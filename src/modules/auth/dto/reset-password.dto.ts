import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, MinLength } from 'class-validator';
import { ForgotPasswordDto } from './forgot-password.dto';

export class ResetPasswordDto extends ForgotPasswordDto {
  @ApiProperty({
    example: '123456',
    description: 'Verification code sent by SMS or email',
  })
  @IsString()
  @Length(4, 10)
  code!: string;

  @ApiProperty({ example: 'NewPassword123!' })
  @IsString()
  @MinLength(8)
  newPassword!: string;
}
