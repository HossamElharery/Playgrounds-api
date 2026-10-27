import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { PageQueryDto } from '../../../common/dto/page-query.dto';

export class ListBlogQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: ['draft', 'published', 'archived'],
    example: 'published',
    description:
      'Admin-only filter. Values: draft | published | archived. Never "Active". Omit to list every post.',
  })
  @IsOptional()
  @IsIn(['draft', 'published', 'archived'])
  status?: 'draft' | 'published' | 'archived';

  @ApiPropertyOptional({ description: 'Filter by BlogCategory id.' })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Filter by related sport slug (e.g. "padel").' })
  @IsOptional()
  @IsString()
  relatedSportSlug?: string;

  @ApiPropertyOptional({ description: 'Admin-only. Case-insensitive match against the Arabic/English title or subtitle.' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description: 'Card view: omit the article HTML and send readingMinutesAr/En instead (lists stay small).',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  summary?: 'true' | 'false';
}

export class ListSupportQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: ['new', 'read'],
    example: 'new',
    description: 'Support inbox filter. Omit to list all.',
  })
  @IsOptional()
  @IsIn(['new', 'read'])
  status?: 'new' | 'read';
}

export class ListBannersQueryDto {
  @ApiPropertyOptional({ example: 'home-hero' })
  @IsOptional()
  @IsString()
  placement?: string;
}
