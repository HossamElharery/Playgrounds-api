import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { Prisma } from '@prisma/client';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionsFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      response.status(status).json(
        typeof body === 'string'
          ? { message: body, statusCode: status }
          : { statusCode: status, ...(body as object) },
      );
      return;
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = this.mapPrismaError(exception);
      response.status(mapped.status).json({ message: mapped.message, statusCode: mapped.status });
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : exception);
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ message: 'Internal server error', statusCode: HttpStatus.INTERNAL_SERVER_ERROR });
  }

  private mapPrismaError(error: Prisma.PrismaClientKnownRequestError): {
    status: number;
    message: string;
  } {
    switch (error.code) {
      case 'P2002': {
        // Unique constraint violation. The booking slot partial-unique-index
        // surfaces here as a clean, typed conflict instead of a raw DB error.
        const target = (error.meta?.target as string[] | undefined)?.join(', ');
        if (target?.includes('courtId') || target?.includes('slotStart')) {
          return { status: HttpStatus.CONFLICT, message: 'SLOT_ALREADY_HELD' };
        }
        return { status: HttpStatus.CONFLICT, message: `Duplicate value for ${target ?? 'field'}` };
      }
      case 'P2025':
        return { status: HttpStatus.NOT_FOUND, message: 'Record not found' };
      case 'P2003':
        return { status: HttpStatus.BAD_REQUEST, message: 'Invalid reference' };
      default:
        return { status: HttpStatus.BAD_REQUEST, message: 'Database error' };
    }
  }
}
