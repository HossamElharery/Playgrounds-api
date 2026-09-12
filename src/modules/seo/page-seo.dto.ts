import { IsString, MaxLength } from 'class-validator';

export class UpdatePageSeoDto {
  @IsString() @MaxLength(60) titleAr!: string;
  @IsString() @MaxLength(60) titleEn!: string;
  @IsString() @MaxLength(160) descriptionAr!: string;
  @IsString() @MaxLength(160) descriptionEn!: string;
}
