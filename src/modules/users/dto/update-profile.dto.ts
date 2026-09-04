import { IsIn, IsOptional, IsString } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsIn(['ar', 'en'])
  preferredLang?: string;
}
