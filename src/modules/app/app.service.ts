import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  health() {
    return {
      status: 'ok',
      service: 'matchena-api',
      time: new Date().toISOString(),
    };
  }
}
