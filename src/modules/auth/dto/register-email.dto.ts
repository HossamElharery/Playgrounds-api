import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsPhoneNumber, IsString, MinLength } from 'class-validator';

/** Player signup by email + password. Phone is optional — the OTP-SMS flow
 * remains available but is no longer required to create an account. */
export class RegisterEmailDto {
  @ApiProperty({ example: 'player@matchena.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Password123!' })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiProperty({ example: 'Ahmed Mohamed' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ example: '+201001112223' })
  @IsOptional()
  @IsPhoneNumber()
  phone?: string;

  @ApiPropertyOptional({ example: 'EG' })
  @IsOptional()
  @IsString()
  countryCode?: string;
}
