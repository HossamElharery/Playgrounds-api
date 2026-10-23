import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { DeviceLinksService } from './device-links.service';

/** Notes which device a signed-in account is used from (header `x-device-id`). Never slows or fails a request. */
@Injectable()
export class DeviceTrackingInterceptor implements NestInterceptor {
  constructor(private readonly devices: DeviceLinksService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const req = context.switchToHttp().getRequest<{
        user?: { id?: string };
        headers?: Record<string, string | string[] | undefined>;
      }>();
      const raw = req.headers?.['x-device-id'];
      const id = Array.isArray(raw) ? raw[0] : raw;
      if (req.user?.id && id) void this.devices.record(req.user.id, id).catch(() => undefined);
    }
    return next.handle();
  }
}
