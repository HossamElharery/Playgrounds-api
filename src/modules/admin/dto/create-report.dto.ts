import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export class CreateReportDto {
  @ApiProperty({
    example: 'player',
    enum: ['post', 'review', 'chat', 'player', 'venue'],
  })
  @IsIn(['post', 'review', 'chat', 'player', 'venue'])
  entityType!: 'post' | 'review' | 'chat' | 'player' | 'venue';

  @ApiProperty({ example: 'entity-uuid' })
  @IsString()
  entityId!: string;

  @ApiPropertyOptional({ example: 'reported-user-uuid' })
  @IsOptional()
  @IsString()
  reportedUserId?: string;

  @ApiProperty({ example: 'Harassment in chat' })
  @IsString()
  reason!: string;
}
