import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class OAuthAppleDto {
  @ApiProperty({ description: 'Identity token (JWT) from Sign in with Apple' })
  @IsString()
  identityToken!: string;

  @ApiPropertyOptional({ description: 'Nonce sent with the authorization request, verified when present' })
  @IsOptional()
  @IsString()
  nonce?: string;

  @ApiPropertyOptional({ description: 'Full name — Apple only shares it on the very first sign-in' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}
