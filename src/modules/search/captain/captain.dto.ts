import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CaptainTurnDto {
  @ApiProperty({ enum: ['player', 'captain'] })
  @IsIn(['player', 'captain'])
  from!: 'player' | 'captain';

  @ApiProperty({ maxLength: 300 })
  @IsString()
  @MaxLength(300)
  text!: string;
}

export class CaptainAskDto {
  @ApiProperty({ description: 'What the player said or typed.' })
  @IsString()
  @MinLength(2)
  @MaxLength(300)
  text!: string;

  @ApiPropertyOptional({ enum: ['ar', 'en'] })
  @IsOptional()
  @IsIn(['ar', 'en'])
  lang?: 'ar' | 'en';

  @ApiPropertyOptional({ description: 'Only sent when the browser already granted geolocation.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  lat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  lng?: number;

  /** A random id the browser keeps, so one visitor's messages are counted together. Never trusted for identity. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(80)
  deviceId?: string;

  /** The token Cloudflare Turnstile produced in the visitor's browser; only sent after the server asked for it. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2100)
  challengeToken?: string;

  /** The last few turns, oldest first, so "وكمان" and "أرخص من كده" are read in context. */
  @ApiPropertyOptional({ type: () => [CaptainTurnDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => CaptainTurnDto)
  history?: CaptainTurnDto[];

  /** `context` of the previous reply. Untrusted: every field is re-validated against the catalogue. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;
}

export class CaptainFeedbackDto {
  @ApiProperty({ enum: ['up', 'down'] })
  @IsIn(['up', 'down'])
  value!: 'up' | 'down';
}
