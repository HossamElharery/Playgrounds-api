declare module 'helmet' {
  import type { RequestHandler } from 'express';

  function helmet(options?: {
    crossOriginResourcePolicy?: { policy: 'cross-origin' | 'same-origin' | 'same-site' };
  }): RequestHandler;

  export default helmet;
}
