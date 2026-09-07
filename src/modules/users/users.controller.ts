import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import type { MulterFile } from '../../common/types/multer-file.type';
import { UsersService } from './users.service';
import { StorageService } from '../storage/storage.service';
import { IMAGE_UPLOAD_OPTIONS } from '../../common/uploads/image-upload';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateAvatarConfigDto } from './dto/update-avatar-config.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UpdateUserStatusDto } from './dto/update-status.dto';
import { UpdatePrivacyDto } from './dto/block-user.dto';
import { ListPlayersQueryDto } from './dto/list-players-query.dto';

@ApiTags('users')
@Controller()
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly storage: StorageService,
  ) {}

  @Public()
  @Get('players')
  listPlayers(@Query() query: ListPlayersQueryDto) {
    return this.usersService.listPlayers(query);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('users/me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.me(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Patch('users/me')
  updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.usersService.updateProfile(user.id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Patch('users/me/privacy')
  updatePrivacy(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdatePrivacyDto,
  ) {
    return this.usersService.updatePrivacy(user.id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('users/me/favorites')
  myFavorites(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.listFavorites(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('users/me/blocks')
  myBlocks(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.listBlocks(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Patch('users/me/avatar')
  @UseInterceptors(FileInterceptor('avatar', IMAGE_UPLOAD_OPTIONS))
  async updateAvatar(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: MulterFile,
  ) {
    if (!file?.buffer) throw new BadRequestException('avatar file is required');
    const uploaded = await this.storage.uploadBuffer(
      file.buffer,
      file.originalname,
      file.mimetype,
      'avatars',
    );
    return this.usersService.updateAvatarUrl(user.id, uploaded.url);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Patch('users/me/avatar-config')
  updateAvatarConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateAvatarConfigDto,
  ) {
    return this.usersService.updateAvatarConfig(user.id, dto);
  }

  @Public()
  @Get('users/:id/public')
  publicProfile(@Param('id') id: string) {
    return this.usersService.publicProfile(id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('users/:id/block')
  block(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.usersService.block(user.id, id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Delete('users/:id/block')
  unblock(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.usersService.unblock(user.id, id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Get('users')
  async list(@Query() query: ListUsersQueryDto) {
    const { items, pagination } = await this.usersService.list(query);
    return { message: 'users retrieved', result: items, pagination };
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Patch('users/:id/status')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateUserStatusDto) {
    return this.usersService.updateStatus(id, dto.status);
  }
}
