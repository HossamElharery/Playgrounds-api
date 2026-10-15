import { Module } from '@nestjs/common';
import { AreaCatalogService } from '../geo/area-catalog.service';
import { PartnerLinksController } from './partner-links.controller';
import { PartnerLinksService } from './partner-links.service';

@Module({
  controllers: [PartnerLinksController],
  providers: [PartnerLinksService, AreaCatalogService],
})
export class PartnerLinksModule {}
