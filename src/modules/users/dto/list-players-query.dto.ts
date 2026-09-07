import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { CursorPaginationQueryDto } from '../../../common/pagination/cursor-pagination.dto';

export class ListPlayersQueryDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({ example: 'omar' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: 'sport-football-5' })
  @IsOptional()
  @IsString()
  sportId?: string;

  @ApiPropertyOptional({ example: 'level', enum: ['level', 'reputation', 'matches', 'name'] })
  @IsOptional()
  @IsIn(['level', 'reputation', 'matches', 'name'])
  sort?: 'level' | 'reputation' | 'matches' | 'name';
}
