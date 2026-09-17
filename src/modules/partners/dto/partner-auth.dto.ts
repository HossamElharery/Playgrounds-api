import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { USERNAME_PATTERN } from '../../../common/utils/username.util';
import { NormalizeEmail, TrimString } from '../../../common/validation/email.transform';

export class PartnerRegisterDto {
  @ApiProperty({ example: 'Ahmed El-Malek' })
  @TrimString()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @ApiProperty({ example: 'elmalek' })
  @IsString()
  @Matches(USERNAME_PATTERN, {
    message:
      'Username must start with a letter and be 4–30 letters, digits, dots or underscores',
  })
  username!: string;

  @ApiProperty({ example: 'new.owner@matchena.com' })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: '+201001112223' })
  @IsPhoneNumber()
  phone!: string;

  @ApiProperty({ example: 'Password123!' })
  @IsString()
  @MinLength(10)
  @MaxLength(128)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'Password must contain letters and numbers',
  })
  password!: string;

  @ApiPropertyOptional({ example: 'EG' })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  countryCode?: string;
}

export class PartnerLoginDto {
  @ApiPropertyOptional({ example: 'elmalek' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  username?: string;

  @ApiPropertyOptional({ example: 'owner@matchena.com' })
  @IsOptional()
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiProperty({ example: 'Password123!' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}

export class UsernameAvailabilityQueryDto {
  @ApiProperty({ example: 'elmalek' })
  @IsString()
  @MinLength(4)
  @MaxLength(30)
  username!: string;
}
