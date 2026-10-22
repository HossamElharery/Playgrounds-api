import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** Body of `POST /auth/guest/play`: an instant guest for the camo game (no squad needed). */
export class GuestPlayDto {
  @ApiPropertyOptional({ description: 'Optional nickname (max 24 chars)' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional({ enum: ['ar', 'en'] })
  @IsOptional()
  @IsIn(['ar', 'en'])
  lang?: 'ar' | 'en';

  @ApiPropertyOptional({ description: 'Cloudflare Turnstile token of the hidden widget' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  turnstileToken?: string;

  @ApiPropertyOptional({ description: 'Stable id of this device (stored in the browser/app)' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  deviceId?: string;
}
