import { IsString } from 'class-validator';

export class OAuthGoogleDto {
  @IsString()
  idToken!: string;
}
