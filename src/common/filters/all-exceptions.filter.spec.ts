import { Prisma } from '@prisma/client';
import { HttpStatus } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ApiException } from '../errors/api-exception';

function run(exception: unknown) {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  const host: any = { switchToHttp: () => ({ getResponse: () => res }) };
  new AllExceptionsFilter().catch(exception, host);
  return {
    status: res.status.mock.calls[0][0],
    body: res.json.mock.calls[0][0],
  };
}

describe('AllExceptionsFilter 429 handling', () => {
  it('returns a typed conflict after a rolled-back concurrent database write', () => {
    const error = new Prisma.PrismaClientKnownRequestError('write conflict', {code:'P2034',clientVersion:'test'});
    expect(run(error)).toEqual({status:409,body:{statusCode:409,message:'CONCURRENT_CHANGE',code:'CONCURRENT_CHANGE'}});
  });

  it('keeps normalising the throttler 429 to RATE_LIMITED', () => {
    const { status, body } = run(new ThrottlerException());
    expect(status).toBe(429);
    expect(body).toEqual({
      statusCode: 429,
      message: 'Too many requests. Please wait a moment and try again.',
      code: 'RATE_LIMITED',
    });
  });

  it('passes a deliberate ApiException 429 through with its code and result', () => {
    const { status, body } = run(
      new ApiException(HttpStatus.TOO_MANY_REQUESTS, 'MORPH_COOLDOWN', 'Wait', {
        retryAfterMs: 400,
      }),
    );
    expect(status).toBe(429);
    expect(body).toEqual({
      statusCode: 429,
      message: 'Wait',
      code: 'MORPH_COOLDOWN',
      result: { retryAfterMs: 400 },
    });
  });
});
