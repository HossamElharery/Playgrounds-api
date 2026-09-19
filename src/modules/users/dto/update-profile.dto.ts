import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsPhoneNumber,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { normalizeOptionalPhone } from '../../../common/utils/phone.util';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Omar Hassan' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 'ar', enum: ['ar', 'en'] })
  @IsOptional()
  @IsIn(['ar', 'en'])
  preferredLang?: string;

  @ApiPropertyOptional({ example: 'Football lover since childhood' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bioEn?: string;

  @ApiPropertyOptional({ example: 'بحب الكورة من وأنا صغير' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bioAr?: string;

  @ApiPropertyOptional({ example: 'SA' })
  @IsOptional()
  @IsString()
  countryCode?: string;

  @ApiPropertyOptional({
    example: '+201001112223',
    nullable: true,
    description:
      'E.164 number. Send null or empty to remove. Not OTP-verified — the player can set and edit it freely.',
  })
  @Transform(({ value }) =>
    value === undefined ? undefined : normalizeOptionalPhone(value),
  )
  @IsOptional()
  @ValidateIf((_, v) => typeof v === 'string' && v.length > 0)
  @IsPhoneNumber()
  phone?: string | null;
}
