import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';

export class UpsertBannerDto {
  @ApiProperty({ example: 'Ramadan night games' })
  @IsString()
  titleEn!: string;

  @ApiProperty({ example: 'مباريات رمضان' })
  @IsString()
  titleAr!: string;

  @ApiProperty({ example: 'https://cdn.mal3ab.app/banners/ramadan.jpg' })
  @IsString()
  imageUrl!: string;

  @ApiPropertyOptional({ example: '/explore?sport=football-5' })
  @IsOptional()
  @IsString()
  linkUrl?: string;

  @ApiProperty({ example: 'home-hero' })
  @IsString()
  placement!: string;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  position?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
