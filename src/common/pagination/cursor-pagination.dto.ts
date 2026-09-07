import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { clampLimit } from '../utils/page-limit.util';

export class CursorPaginationQueryDto {
  @ApiPropertyOptional({ example: undefined, description: 'Pass the previous page nextCursor' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ example: 30, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 30;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor?: string;
}

/** Generic cursor pagination over an id-ordered Prisma findMany call. */
export async function paginateByCursor<T extends { id: string }>(
  findMany: (args: {
    take: number;
    skip?: number;
    cursor?: { id: string };
  }) => Promise<T[]>,
  limit: number,
  cursor?: string,
): Promise<CursorPage<T>> {
  const safeLimit = clampLimit(limit, 30, 100);
  const take = safeLimit + 1;
  const items = await findMany(
    cursor ? { take, skip: 1, cursor: { id: cursor } } : { take },
  );
  const hasMore = items.length > safeLimit;
  const page = hasMore ? items.slice(0, safeLimit) : items;
  return {
    items: page,
    nextCursor: hasMore ? page[page.length - 1].id : undefined,
  };
}
