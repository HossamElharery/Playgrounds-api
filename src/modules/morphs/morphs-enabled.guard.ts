import { CanActivate, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiException } from '../../common/errors/api-exception';
import { lobbyMorphsEnabled } from './morphs-flag';

/** Hides morph endpoints (404) while the feature flag is off. */
@Injectable()
export class MorphsEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    if (!lobbyMorphsEnabled(this.config)) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'MORPHS_DISABLED',
        'Lobby morphs are disabled',
      );
    }
    return true;
  }
}
