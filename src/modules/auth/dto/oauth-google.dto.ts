import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class OAuthGoogleDto {
  @ApiProperty({
    example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjkifQ.google-id-token',
    description: 'Google ID token from the client SDK (not a server client-secret)',
  })
  @IsString()
  idToken!: string;
}
