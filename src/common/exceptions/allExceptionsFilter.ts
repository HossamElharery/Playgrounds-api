/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-misused-promises */
import {
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import handlePrismaErrors from './prismaExceptionsFilter';

type MyResponseObj = {
  timestamp: string;
  path: string;
  response: {
    message: string;
    error: string;
  };
};

@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  async catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const myResponseObj: MyResponseObj = {
      timestamp: new Date().toISOString(),
      path: request.url,
      response: {
        message: 'An unexpected error occurred',
        error: 'Internal Server Error',
      },
    };
    console.log(exception);

    // ✅ Handle NestJS HTTP Exceptions
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const { message, error } = exceptionResponse as any;
        myResponseObj.response.message = message || 'Unknown error';
        myResponseObj.response.error = error || HttpStatus[status] || 'Error';
      } else {
        myResponseObj.response.message = String(exceptionResponse);
        myResponseObj.response.error = HttpStatus[status] || 'Error';
      }

      return response.status(status).json(myResponseObj);
    }

    // ✅ Handle Prisma Client Errors
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const { statusCode, message } = handlePrismaErrors(exception);
      myResponseObj.response.message = message;
      myResponseObj.response.error = 'Database Error';
      return response.status(statusCode).json(myResponseObj);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      // Extract a clean error message
      // const cleanMessage = exception.message
      //   .split('\n') // Split the message by lines
      //   .filter(line => !line.trim().startsWith('at')) // Remove stack trace lines
      //   .filter(line => !line.includes('invocation in')) // Remove invocation details
      //   .join(' ') // Join the remaining lines into a single message
      //   .replace(/\+/g, '') // Remove unnecessary symbols
      //   .trim();

      myResponseObj.response.message = 'Invalid input data';
      myResponseObj.response.error = 'Validation Error';
      return response.status(HttpStatus.BAD_REQUEST).json(myResponseObj);
    }

    if (exception instanceof Prisma.PrismaClientInitializationError) {
      myResponseObj.response.message = 'Database connection error';
      myResponseObj.response.error = 'Database Initialization Error';
      return response
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json(myResponseObj);
    }

    if (exception instanceof Prisma.PrismaClientRustPanicError) {
      myResponseObj.response.message = 'A database runtime error occurred';
      myResponseObj.response.error = 'Database Panic Error';
      return response
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json(myResponseObj);
    }

    // ✅ Catch-all for unhandled exceptions
    console.error('Unhandled Exception:', exception);
    return response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json(myResponseObj);
  }
}
