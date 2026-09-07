import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { CursorPaginationQueryDto } from '../../../common/pagination/cursor-pagination.dto';

export class PulseFeedQueryDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({ example: 'for-you', enum: ['for-you', 'rescue', 'friends'] })
  @IsOptional()
  @IsIn(['for-you', 'rescue', 'friends'])
  scope?: string;

  @ApiPropertyOptional({ example: 'sport-football-5' })
  @IsOptional()
  @IsString()
  sportId?: string;
}
