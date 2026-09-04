import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

export class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
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
