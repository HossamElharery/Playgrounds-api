import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from, of } from 'rxjs';
import { switchMap, tap } from 'rxjs/operators';
import { PrismaService } from '../../modules/prisma/prisma.service';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const key = request.headers['idempotency-key'] as string | undefined;
    const userId = request.user?.id as string | undefined;

    if (
      !key ||
      !userId ||
      !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
    ) {
      return next.handle();
    }

    const compositeKey = `${userId}:${key}`;

    return from(
      this.prisma.idempotencyKey.findUnique({ where: { key: compositeKey } }),
    ).pipe(
      switchMap((existing) => {
        if (existing) {
          return of(existing.responseBody);
        }
        return next.handle().pipe(
          tap((response) => {
            void this.prisma.idempotencyKey
              .create({
                data: {
                  key: compositeKey,
                  userId,
                  responseBody: response,
                  statusCode: 200,
                },
              })
              .catch(() => {
                throw new ConflictException('Duplicate request in flight');
              });
          }),
        );
      }),
    );
  }
}
