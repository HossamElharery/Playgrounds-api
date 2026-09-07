import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiResponse<T> {
  message: string;
  result: T;
  pagination?: unknown;
}

/**
 * Wraps every successful response in `{ message, result, pagination? }`.
 * A handler may return `{ message, result, pagination }` directly to
 * override the default message/shape (paginated list endpoints do this).
 */
@Injectable()
export class ResponseInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T>>
{
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    return next.handle().pipe(
      map((data) => {
        if (data instanceof StreamableFile) return data as unknown as ApiResponse<T>;
        if (
          data &&
          typeof data === 'object' &&
          'result' in data &&
          'message' in data
        ) {
          return data as ApiResponse<T>;
        }
        return { message: 'ok', result: data };
      }),
    );
  }
}
