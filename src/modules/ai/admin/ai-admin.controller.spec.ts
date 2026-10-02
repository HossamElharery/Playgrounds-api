import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthGuard } from '../../../common/guards/auth.guard';
import { ROLES_KEY } from '../../../common/decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { AiAdminController } from './ai-admin.controller';

describe('AiAdminController access', () => {
  it('is guarded by authentication and restricted to admins at the class level', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AiAdminController)).toContain(AuthGuard);
    expect(Reflect.getMetadata(ROLES_KEY, AiAdminController)).toEqual(['admin']);
  });

  it('exposes no public route, and no handler loosens the role', () => {
    const proto = AiAdminController.prototype as unknown as Record<string, unknown>;
    const handlers = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && typeof proto[n] === 'function');
    expect(handlers.length).toBeGreaterThan(20);
    for (const name of handlers) {
      expect({ name, public: Reflect.getMetadata(IS_PUBLIC_KEY, proto[name] as object) }).toEqual({ name, public: undefined });
      const roles = Reflect.getMetadata(ROLES_KEY, proto[name] as object);
      expect({ name, roles: roles ?? ['admin'] }).toEqual({ name, roles: ['admin'] });
    }
  });
});
