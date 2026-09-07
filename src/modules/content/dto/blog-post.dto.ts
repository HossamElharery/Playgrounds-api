import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export class CreateBlogPostDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiProperty({ example: 'How to book a padel court' })
  @IsString()
  titleEn!: string;

  @ApiProperty({ example: 'إزاي تحجز ملعب بادل' })
  @IsString()
  titleAr!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subtitleEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subtitleAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  coverImageUrl?: string;

  @ApiProperty({ example: '<p>Open Explore, pick Padel, choose a slot.</p>' })
  @IsString()
  contentEn!: string;

  @ApiProperty({ example: '<p>افتح استكشف، اختار بادل، واحجز المعاد.</p>' })
  @IsString()
  contentAr!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional({ example: 'published', enum: ['draft', 'published', 'archived'] })
  @IsOptional()
  @IsIn(['draft', 'published', 'archived'])
  status?: string;
}

export class UpdateBlogPostDto {
  @ApiPropertyOptional({ example: 'how-to-book-a-padel-court' })
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiPropertyOptional({ example: 'How to book a padel court' })
  @IsOptional()
  @IsString()
  titleEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  titleAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subtitleEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subtitleAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  coverImageUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contentEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contentAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional({ example: 'published', enum: ['draft', 'published', 'archived'] })
  @IsOptional()
  @IsIn(['draft', 'published', 'archived'])
  status?: string;
}
