import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsPhoneNumber, IsString, MinLength } from 'class-validator';

/** Venue-owner / staff-facing signup (email+password), separate from the phone-OTP player flow. */
export class RegisterOwnerDto {
  @ApiProperty({ example: 'new.owner@mal3ab.app' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Password123!' })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiProperty({ example: 'Ahmed El-Malek' })
  @IsString()
  name!: string;

  @ApiProperty({ example: '+201001112223' })
  @IsPhoneNumber()
  phone!: string;

  @ApiPropertyOptional({ example: 'EG' })
  @IsOptional()
  @IsString()
  countryCode?: string;
}
