import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Max, Min } from 'class-validator';

/** Matches AvatarConfig in core/models/mal3ab.model.ts (§13.2). */
export class UpdateAvatarConfigDto {
  @ApiProperty({ example: '#c68642' })
  @IsString()
  skinTone!: string;

  @ApiProperty({ example: '#1c1310' })
  @IsString()
  hairColor!: string;

  @ApiProperty({ example: '#c6ff3d' })
  @IsString()
  kitColor!: string;

  @ApiProperty({ example: 'sport-football-5' })
  @IsString()
  sportId!: string;

  @ApiProperty({ example: 10, minimum: 0, maximum: 99 })
  @IsInt()
  @Min(0)
  @Max(99)
  number!: number;
}
