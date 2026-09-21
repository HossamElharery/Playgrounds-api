import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  health() {
    return this.appService.health();
  }

  @Public()
  @Get('ready')
  async ready() {
    try {
      const out = await this.appService.ready();
      if (out.status !== 'ready') throw new ServiceUnavailableException(out);
      return out;
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      throw new ServiceUnavailableException({ status: 'db_unreachable' });
    }
  }
}
