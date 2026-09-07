import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsObject, IsOptional, IsString } from 'class-validator';

export class RegisterDeviceTokenDto {
  @ApiProperty({ example: 'fcm-or-web-push-token' })
  @IsString()
  token!: string;

  @ApiPropertyOptional({ example: 'web', enum: ['web', 'ios', 'android'] })
  @IsOptional()
  @IsIn(['web', 'ios', 'android'])
  platform?: string;
}

export class UpdateNotificationPrefsDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  chat?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  friends?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  matches?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  squad?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  bookings?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  pulse?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  marketing?: boolean;

  @ApiPropertyOptional({ example: { offers: true } })
  @IsOptional()
  @IsObject()
  extra?: Record<string, boolean>;
}
