import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { NormalizeEmail, TrimString } from '../../../common/validation/email.transform';

export class RegisterEmailDto {
  @ApiProperty({ example: 'ahmed@matchena.com' })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: 'Password123!' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'Password must contain letters and numbers',
  })
  password!: string;

  @ApiProperty({ example: 'Ahmed Mohamed' })
  @TrimString()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ example: 'EG' })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  countryCode?: string;

  @ApiPropertyOptional({
    example: 'a1b2c3d4-...',
    description: "Inviting friend's User.referralCode",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  referralCode?: string;
}
