import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';
import { ForgotPasswordDto } from './forgot-password.dto';

export class ResetPasswordDto extends ForgotPasswordDto {
  @ApiProperty({ example: '482917', description: '6-digit code sent to email' })
  @IsString()
  @Length(4, 10)
  @Matches(/^\d+$/, { message: 'Code must be numeric' })
  code!: string;

  @ApiProperty({ example: 'NewPassword123!' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'Password must contain letters and numbers',
  })
  newPassword!: string;
}
