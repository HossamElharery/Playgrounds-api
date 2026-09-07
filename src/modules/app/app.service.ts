import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  health() {
    return {
      status: 'ok',
      service: 'mal3ab-api',
      time: new Date().toISOString(),
    };
  }
}
