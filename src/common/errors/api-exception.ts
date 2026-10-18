import { HttpException, HttpStatus } from '@nestjs/common';

export class ApiException extends HttpException {
  constructor(
    status: HttpStatus,
    code: string,
    message: string,
    result?: Record<string, unknown>,
  ) {
    super(
      { statusCode: status, code, message, ...(result ? { result } : {}) },
      status,
    );
  }
}
