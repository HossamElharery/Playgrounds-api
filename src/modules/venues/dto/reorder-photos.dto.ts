import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString } from 'class-validator';

export class ReorderPhotosDto {
  @ApiProperty({ type: [String], description: 'Photo ids in the desired display order' })
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  orderedIds!: string[];
}
