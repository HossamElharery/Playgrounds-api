import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { CursorPaginationQueryDto } from '../../../common/pagination/cursor-pagination.dto';

export class ListPostsQueryDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({ enum: ['following', 'discover'] })
  @IsOptional()
  @IsIn(['following', 'discover'])
  tab?: 'following' | 'discover';
}

export class ListCommentsQueryDto extends CursorPaginationQueryDto {}

export class ListHashtagPostsQueryDto extends CursorPaginationQueryDto {}
