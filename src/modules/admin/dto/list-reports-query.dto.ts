import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PageQueryDto } from '../../../common/dto/page-query.dto';

export class ListReportsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: ['open', 'resolved', 'dismissed'],
    example: 'open',
  })
  @IsOptional()
  @IsIn(['open', 'resolved', 'dismissed'])
  status?: 'open' | 'resolved' | 'dismissed';
}
