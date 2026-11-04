import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ListOnlineUsersDto {
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  perPage = 25;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsIn(['player', 'owner', 'staff', 'admin'])
  role?: 'player' | 'owner' | 'staff' | 'admin';

  @IsOptional()
  @IsIn(['all', 'live', 'in_squad', 'recent'])
  state: 'all' | 'live' | 'in_squad' | 'recent' = 'all';
}
