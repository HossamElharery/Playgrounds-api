import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

/**
 * Attaches `request.user` when a valid access token is present.
 * Never throws — an expired/missing/invalid token just means an
 * anonymous request, and it is AuthGuard's job (not this middleware's)
 * to decide whether the route requires auth. This is what lets public
 * routes keep working for a visitor carrying a stale token.
 */
@Injectable()
export class AuthContextMiddleware implements NestMiddleware {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async use(request: Request, _res: Response, next: NextFunction): Promise<void> {
    const token = this.extractTokenFromHeader(request) ?? this.extractTokenFromCookie(request);

    if (token) {
      try {
        const payload = await this.jwtService.verifyAsync(token, {
          secret: this.config.get<string>('JWT_ACCESS_SECRET'),
        });
        (request as any).user = payload;
      } catch {
        // invalid/expired token -> treat as anonymous, do not throw here
      }
    }

    next();
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const authHeader = request.header('Authorization');
    if (!authHeader) return undefined;
    const [scheme, token] = authHeader.split(' ');
    return scheme?.toLowerCase() === 'bearer' ? token : undefined;
  }

  private extractTokenFromCookie(request: Request): string | undefined {
    return (request as any).cookies?.['mal3ab_access_token'];
  }
}
