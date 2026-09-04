import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CursorPaginationQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

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
  findMany: (args: { take: number; skip?: number; cursor?: { id: string } }) => Promise<T[]>,
  limit: number,
  cursor?: string,
): Promise<CursorPage<T>> {
  const take = limit + 1;
  const items = await findMany(
    cursor ? { take, skip: 1, cursor: { id: cursor } } : { take },
  );
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  return { items: page, nextCursor: hasMore ? page[page.length - 1].id : undefined };
}
