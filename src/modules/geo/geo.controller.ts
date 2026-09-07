import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { GeoService } from './geo.service';
import {
  GeoDistrictsQueryDto,
  GeoGovernoratesQueryDto,
} from './dto/geo-query.dto';

@ApiTags('geo')
@Controller('geo')
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  @Public()
  @Get('countries')
  @ApiOperation({ summary: 'Active countries (currency, timezone, payment rails)' })
  listCountries() {
    return this.geo.listCountries();
  }

  @Public()
  @Get('countries/:code')
  getCountry(@Param('code') code: string) {
    return this.geo.getCountry(code);
  }

  @Public()
  @Get('governorates')
  @ApiOperation({ summary: 'Governorates for a country (pass country=EG)' })
  listGovernorates(@Query() q: GeoGovernoratesQueryDto) {
    return this.geo.listGovernorates(q.country);
  }

  @Public()
  @Get('districts')
  @ApiOperation({
    summary: 'Districts (governorateId or gov slug). Includes GeoJSON polygon.',
  })
  listDistricts(@Query() q: GeoDistrictsQueryDto) {
    return this.geo.listDistricts(q.governorateId, q.gov, q.country);
  }
}
