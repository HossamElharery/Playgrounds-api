import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PageQueryDto } from '../../../common/dto/page-query.dto';

export class ListUsersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ example: 'admin' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: 'player' })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional({ example: 'active' })
  @IsOptional()
  @IsString()
  status?: string;
}
