import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class CreateBlogCategoryDto {
  @ApiProperty({ example: 'Guides' })
  @IsString()
  nameEn!: string;

  @ApiProperty({ example: 'أدلة' })
  @IsString()
  nameAr!: string;
}
