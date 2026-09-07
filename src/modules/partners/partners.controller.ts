import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import type { MulterFile } from '../../common/types/multer-file.type';
import { StorageService } from '../storage/storage.service';
import { IMAGE_UPLOAD_OPTIONS } from '../../common/uploads/image-upload';
import { DOCUMENT_UPLOAD_OPTIONS } from '../../common/uploads/document-upload';
import { PartnersService } from './partners.service';
import {
  PartnerLoginDto,
  PartnerRegisterDto,
  UsernameAvailabilityQueryDto,
} from './dto/partner-auth.dto';
import {
  AdminAmendPartnerApplicationDto,
  AdminPartnerApplicationsQueryDto,
  CreatePartnerApplicationDto,
  PartnerDecisionDto,
  PatchPartnerApplicationDto,
} from './dto/partner-application.dto';
import { PartnerApplicationStatus } from '@prisma/client';

@ApiTags('partners')
@Controller()
export class PartnersController {
  constructor(
    private readonly partners: PartnersService,
    private readonly storage: StorageService,
  ) {}

  @Public()
  @Get('partners/username-availability')
  usernameAvailability(@Query() query: UsernameAvailabilityQueryDto) {
    return this.partners.usernameAvailability(query.username);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('partners/register')
  async register(@Body() dto: PartnerRegisterDto) {
    const result = await this.partners.register(dto);
    return { message: 'account created', result };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('partners/login')
  async login(@Body() dto: PartnerLoginDto) {
    const result = await this.partners.login(dto);
    return { message: 'authenticated', result };
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'admin')
  @Get('partners/applications')
  listMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.partners.listMine(
      user.id,
      cursor,
      limit ? Number(limit) : 20,
    );
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'admin')
  @Post('partners/applications')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePartnerApplicationDto,
  ) {
    return this.partners.createDraft(user.id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'admin')
  @Patch('partners/applications/:id')
  patch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PatchPartnerApplicationDto,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.partners.patchOwned(user.id, id, dto, ifMatch);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'admin')
  @Post('partners/applications/:id/submit')
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.partners.submit(user.id, id, ifMatch);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'admin')
  @Post('partners/uploads')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  async upload(
    @UploadedFile() file: MulterFile,
    @Query('kind') kind: 'image' | 'document' = 'image',
  ) {
    if (!file?.buffer) throw new BadRequestException('file is required');
    const options = kind === 'document' ? DOCUMENT_UPLOAD_OPTIONS : IMAGE_UPLOAD_OPTIONS;
    await new Promise<void>((resolve, reject) => {
      options.fileFilter?.(null as never, file, (err, ok) => {
        if (err || !ok) {
          reject(err ?? new BadRequestException('Unsupported file type'));
          return;
        }
        resolve();
      });
    });
    if (file.size > (options.limits?.fileSize ?? file.size)) {
      throw new BadRequestException('File is too large');
    }
    return this.storage.uploadBuffer(
      file.buffer,
      file.originalname,
      file.mimetype,
      kind === 'document' ? 'partner-docs' : 'partner-photos',
    );
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Get('admin/partner-applications')
  adminList(@Query() query: AdminPartnerApplicationsQueryDto) {
    return this.partners.adminList(
      query.status as PartnerApplicationStatus | undefined,
      query.cursor,
      query.limit,
    );
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Patch('admin/partner-applications/:id')
  adminAmend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AdminAmendPartnerApplicationDto,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.partners.adminAmend(user.id, id, dto, ifMatch);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Post('admin/partner-applications/:id/decisions')
  decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PartnerDecisionDto,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.partners.decide(user.id, id, dto, ifMatch);
  }
}
