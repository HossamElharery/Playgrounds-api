import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsPhoneNumber, IsString, Length } from 'class-validator';

export class VerifyOtpDto {
  @ApiProperty({ example: '+201001234567' })
  @IsPhoneNumber()
  phone!: string;

  @ApiProperty({
    example: '123456',
    description: 'Verification code delivered by the configured SMS provider',
  })
  @IsString()
  @Length(4, 10)
  code!: string;

  @ApiPropertyOptional({
    example: 'Omar Hassan',
    description:
      'Required only when this phone is creating a new player account',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    example: 'SA',
    description: 'ISO country. Inferred from phone prefix when omitted.',
  })
  @IsOptional()
  @IsString()
  countryCode?: string;

  @ApiPropertyOptional({
    example: 'a1b2c3d4-...',
    description:
      "The inviting friend's User.referralCode, captured only when this phone is creating a new account (MATCHENA_ENGAGEMENT_ENGINE_BLUEPRINT.md §4.1's referral.completed event). Ignored for an existing account.",
  })
  @IsOptional()
  @IsString()
  referralCode?: string;
}
