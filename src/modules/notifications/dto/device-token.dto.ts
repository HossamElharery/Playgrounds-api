import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';

class PushKeysDto {
  @ApiProperty()
  @IsString()
  @MaxLength(400)
  p256dh!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(200)
  auth!: string;
}

export class PushSubscribeDto {
  @ApiProperty()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(600)
  endpoint!: string;

  @ApiProperty({ type: PushKeysDto })
  @ValidateNested()
  @Type(() => PushKeysDto)
  keys!: PushKeysDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  userAgent?: string;
}

export class PushUnsubscribeDto {
  @ApiProperty()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(600)
  endpoint!: string;
}

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
