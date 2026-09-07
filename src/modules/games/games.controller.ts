import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { GamesService } from './games.service';
import {
  CreateGameCatalogEntryDto,
  UpdateGameCatalogEntryDto,
} from './dto/game-catalog.dto';

@ApiTags('games')
@Controller()
export class GamesController {
  constructor(private readonly games: GamesService) {}

  @Public()
  @Get('games')
  list() {
    return this.games.list();
  }

  @Public()
  @Get('games/:id')
  get(@Param('id') id: string) {
    return this.games.get(id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Get('admin/games')
  listAdmin(@Query('includeInactive') includeInactive?: string) {
    return this.games.list(includeInactive === 'true');
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Post('admin/games')
  create(@Body() dto: CreateGameCatalogEntryDto) {
    return this.games.create(dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Patch('admin/games/:id')
  update(@Param('id') id: string, @Body() dto: UpdateGameCatalogEntryDto) {
    return this.games.update(id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Delete('admin/games/:id')
  retire(@Param('id') id: string) {
    return this.games.retire(id);
  }
}
