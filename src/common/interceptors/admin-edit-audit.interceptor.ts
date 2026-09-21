import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Observable, tap } from 'rxjs';
import { PrismaService } from '../../modules/prisma/prisma.service';

/**
 * Every change the admin makes while "editing as a venue" leaves a trail:
 * who, what route, which venue, and the reason he gave when he switched edit mode on.
 * Reads are not logged; nothing is logged for anyone but an admin in edit mode.
 */
@Injectable()
export class AdminEditAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AdminEditAuditInterceptor.name);

  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    const method: string = req.method;
    if (!user?.adminEdit || method === 'GET' || method === 'HEAD') return next.handle();

    return next.handle().pipe(
      tap({
        next: () => {
          const raw = req.headers?.['x-admin-edit-reason'];
          let reason: string | null = null;
          if (typeof raw === 'string') {
            try {
              reason = decodeURIComponent(raw).slice(0, 300);
            } catch {
              reason = raw.slice(0, 300);
            }
          }
          const venueId = req.body?.venueId ?? req.query?.venueId ?? req.params?.venueId ?? null;
          this.prisma.auditLogEntry
            .create({
              data: {
                actorUserId: user.id,
                action: 'admin.edit_mode.write',
                targetType: 'owner_api',
                targetId: String(req.params?.id ?? venueId ?? req.route?.path ?? 'owner'),
                metadata: {
                  method,
                  path: String(req.route?.path ?? req.url).slice(0, 200),
                  venueId,
                  reason,
                } as Prisma.InputJsonValue,
              },
            })
            .catch((err: unknown) => this.logger.warn(`admin edit audit failed: ${String(err)}`));
        },
      }),
    );
  }
}
