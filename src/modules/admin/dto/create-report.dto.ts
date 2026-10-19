import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateReportDto {
  @ApiProperty({
    example: 'player',
    enum: ['post', 'review', 'chat', 'player', 'venue'],
  })
  @IsIn(['post', 'review', 'chat', 'player', 'venue'])
  entityType!: 'post' | 'review' | 'chat' | 'player' | 'venue';

  @ApiProperty({ example: 'entity-uuid' })
  @IsString()
  @MaxLength(100)
  entityId!: string;

  @ApiPropertyOptional({ example: 'reported-user-uuid' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reportedUserId?: string;

  @ApiProperty({ example: 'Harassment in chat' })
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  reason!: string;
}
