import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class PageQueryDto {
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ example: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  perPage: number = 20;
}

export function buildPagination(page: number, perPage: number, total: number) {
  const noOfPages = Math.ceil(total / perPage) || 1;
  return {
    currentPage: page,
    perPage,
    total,
    noOfPages,
    hasNextPage: page < noOfPages,
    hasPrevPage: page > 1,
  };
}
