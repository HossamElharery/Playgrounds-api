import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CreateBadgeDto {
  @ApiProperty({ example: 'night_owl' })
  @IsString()
  key!: string;

  @ApiProperty({ example: 'Night Owl' })
  @IsString()
  nameEn!: string;

  @ApiProperty({ example: 'بومة الليل' })
  @IsString()
  nameAr!: string;

  @ApiProperty({ example: 'moon' })
  @IsString()
  icon!: string;

  @ApiPropertyOptional({ example: 'moon', description: 'Stable icon key for clients (§17.5)' })
  @IsOptional()
  @IsString()
  iconKey?: string;

  @ApiPropertyOptional({ example: 'Play 5 matches after 10pm' })
  @IsOptional()
  @IsString()
  descriptionEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  descriptionAr?: string;
}
