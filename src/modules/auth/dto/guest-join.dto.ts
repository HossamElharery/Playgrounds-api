import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class GuestJoinDto {
  @ApiProperty({ description: 'Squad invite link token' })
  @IsString()
  @MaxLength(200)
  token!: string;

  @ApiPropertyOptional({ description: 'Optional nickname (max 24 chars)' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional({ enum: ['ar', 'en'] })
  @IsOptional()
  @IsIn(['ar', 'en'])
  lang?: 'ar' | 'en';
}
