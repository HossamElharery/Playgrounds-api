import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export class ListFriendsQueryDto {
  @ApiPropertyOptional({
    enum: ['all', 'online', 'offline', 'in_squad'],
    example: 'all',
    description:
      'Presence filter on accepted friends — not UserStatus and not "Active".',
  })
  @IsOptional()
  @IsIn(['all', 'online', 'offline', 'in_squad'])
  status?: 'all' | 'online' | 'offline' | 'in_squad';

  @ApiPropertyOptional({ example: 'ahmed' })
  @IsOptional()
  @IsString()
  query?: string;
}

export class ListFriendRequestsQueryDto {
  @ApiPropertyOptional({
    enum: ['incoming', 'outgoing'],
    example: 'incoming',
  })
  @IsOptional()
  @IsIn(['incoming', 'outgoing'])
  direction?: 'incoming' | 'outgoing';
}

export class MatchFeedQueryDto {
  @ApiPropertyOptional({ example: 'sport-padel' })
  @IsOptional()
  @IsString()
  sportId?: string;

  @ApiPropertyOptional({ example: 'dist-nasr-city' })
  @IsOptional()
  @IsString()
  districtId?: string;

  @ApiPropertyOptional({
    enum: ['open', 'full', 'played', 'expired', 'cancelled'],
    example: 'open',
    description:
      'MatchPostStatus. Default open if omitted. Never "Active".',
  })
  @IsOptional()
  @IsIn(['open', 'full', 'played', 'expired', 'cancelled'])
  status?: 'open' | 'full' | 'played' | 'expired' | 'cancelled';
}
