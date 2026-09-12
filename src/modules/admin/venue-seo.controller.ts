import { Body, Controller, Param, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { UpdateVenueSeoDto } from './dto/venue-seo.dto';
import { VenueSeoService } from './venue-seo.service';

@Controller('admin/seo/venues')
@UseGuards(AuthGuard)
@Roles('admin')
export class VenueSeoController {
  constructor(private readonly venueSeo: VenueSeoService) {}

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateVenueSeoDto,
  ) {
    return this.venueSeo.update(user.id, id, dto);
  }
}
