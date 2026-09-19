import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsPhoneNumber, IsString } from 'class-validator';
import { normalizeOptionalPhone } from '../../../common/utils/phone.util';

export class CreateSupportInquiryDto {
  @ApiProperty({ example: 'Omar Hassan' })
  @IsString()
  fullName!: string;

  @ApiProperty({ example: 'omar@mail.com' })
  @IsEmail()
  email!: string;

  @ApiPropertyOptional({ example: '+201001234567' })
  @IsOptional()
  @Transform(({ value }) => normalizeOptionalPhone(value) ?? undefined)
  @IsPhoneNumber()
  phone?: string;

  @ApiProperty({ example: 'I cannot see my booking QR code.' })
  @IsString()
  message!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  userId?: string;
}
