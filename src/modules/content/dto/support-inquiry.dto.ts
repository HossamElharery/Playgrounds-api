import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsPhoneNumber, IsString } from 'class-validator';

export class CreateSupportInquiryDto {
  @ApiProperty({ example: 'Omar Hassan' })
  @IsString()
  fullName!: string;

  @ApiProperty({ example: 'omar@mail.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: '+201001234567' })
  @IsPhoneNumber()
  phone!: string;

  @ApiProperty({ example: 'I cannot see my booking QR code.' })
  @IsString()
  message!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  userId?: string;
}
