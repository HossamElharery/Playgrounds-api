import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class OAuthAppleDto {
  @ApiProperty({ example: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.apple-identity-token' })
  @IsString()
  identityToken!: string;

  @ApiPropertyOptional({ example: 'Omar Hassan' })
  @IsOptional()
  @IsString()
  name?: string;
}
