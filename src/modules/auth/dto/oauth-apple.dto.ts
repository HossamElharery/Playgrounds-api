import { IsOptional, IsString } from 'class-validator';

export class OAuthAppleDto {
  @IsString()
  identityToken!: string;

  @IsOptional()
  @IsString()
  name?: string;
}
