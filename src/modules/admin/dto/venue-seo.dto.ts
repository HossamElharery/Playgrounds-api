import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateVenueSeoDto {
  @IsOptional() @IsString() @MaxLength(60) seoTitleOverrideAr?: string;
  @IsOptional() @IsString() @MaxLength(60) seoTitleOverrideEn?: string;
  @IsOptional() @IsString() @MaxLength(160) seoDescriptionOverrideAr?: string;
  @IsOptional() @IsString() @MaxLength(160) seoDescriptionOverrideEn?: string;
}
