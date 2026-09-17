import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { NormalizeEmail, TrimString } from '../../../common/validation/email.transform';

/** Venue-owner signup (email + password). Phone is optional contact data. */
export class RegisterOwnerDto {
  @ApiProperty({ example: 'new.owner@matchena.com' })
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

  @ApiProperty({ example: 'Ahmed El-Malek' })
  @TrimString()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ example: '+201001112223' })
  @IsOptional()
  @ValidateIf((_, v) => !!v)
  @IsPhoneNumber()
  phone?: string;

  @ApiPropertyOptional({ example: 'EG' })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  countryCode?: string;
}
