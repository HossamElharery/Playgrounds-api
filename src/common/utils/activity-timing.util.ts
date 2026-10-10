import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../errors/api-exception';
export function usesMinuteTiming(activityKind: string | null | undefined): boolean {
  return activityKind === 'gaming-station' || activityKind === 'table-game';
}
export function assertActivityDuration(minutes: number, activityKind: string | null | undefined): void {
  const gaming = usesMinuteTiming(activityKind);
  if (!Number.isSafeInteger(minutes) || minutes < (gaming ? 1 : 15) || minutes > 720 || (!gaming && minutes % 15 !== 0)) {
    throw new ApiException(HttpStatus.BAD_REQUEST, 'INVALID_DURATION', gaming ? 'Duration must be 1 to 720 whole minutes' : 'Duration must be a multiple of 15 minutes, up to 720');
  }
}
