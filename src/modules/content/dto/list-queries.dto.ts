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
