import { Body, Controller, Get, Param, Patch, Query, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { UsersService } from './users.service';
import { StorageService } from '../storage/storage.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateAvatarConfigDto } from './dto/update-avatar-config.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UpdateUserStatusDto } from './dto/update-status.dto';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly storage: StorageService,
  ) {}

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.me(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Patch('me')
  updateMe(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(user.id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Patch('me/avatar')
  @UseInterceptors(FileInterceptor('avatar'))
  async updateAvatar(@CurrentUser() user: AuthenticatedUser, @UploadedFile() file: Express.Multer.File) {
    const uploaded = await this.storage.uploadBuffer(file.buffer, file.originalname, file.mimetype, 'avatars');
    return this.usersService.updateAvatarUrl(user.id, uploaded.url);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Patch('me/avatar-config')
  updateAvatarConfig(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateAvatarConfigDto) {
    return this.usersService.updateAvatarConfig(user.id, dto);
  }

  @Public()
  @Get(':id/public')
  publicProfile(@Param('id') id: string) {
    return this.usersService.publicProfile(id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Get()
  async list(@Query() query: ListUsersQueryDto) {
    const { items, pagination } = await this.usersService.list(query);
    return { message: 'users retrieved', result: items, pagination };
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateUserStatusDto) {
    return this.usersService.updateStatus(id, dto.status);
  }
}
