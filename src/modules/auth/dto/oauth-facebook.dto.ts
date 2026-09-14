import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class OAuthFacebookDto {
  @ApiProperty({
    example: 'EAAB…',
    description: 'Facebook user access token from the JS SDK / OAuth redirect',
  })
  @IsString()
  accessToken!: string;
}
