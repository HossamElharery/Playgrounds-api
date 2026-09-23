import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsPhoneNumber,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { normalizeOptionalPhone } from '../../../common/utils/phone.util';

function trimString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class CreateSupportInquiryDto {
  @ApiProperty({ example: 'Omar Hassan' })
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  fullName!: string;

  @ApiProperty({ example: 'omar@mail.com' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiPropertyOptional({ example: '+201001234567' })
  @IsOptional()
  @Transform(({ value }) => normalizeOptionalPhone(value) ?? undefined)
  @IsPhoneNumber()
  phone?: string;

  @ApiProperty({ example: 'I cannot see my booking QR code.' })
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MinLength(8)
  @MaxLength(2000)
  message!: string;
}
