import { HttpException, HttpStatus } from '@nestjs/common';

/** Typed HTTP error with a stable `code` the frontend can switch on. */
export class ApiException extends HttpException {
  constructor(status: HttpStatus, code: string, message: string) {
    super({ statusCode: status, code, message }, status);
  }
}
