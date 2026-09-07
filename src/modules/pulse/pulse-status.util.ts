import { PulseOpportunityStatus } from '@prisma/client';

export function pulseStatusFromOccupancy(
  capacity: number,
  activeCount: number,
): PulseOpportunityStatus {
  if (activeCount >= capacity) return 'full';
  if (activeCount > 0) return 'held';
  return 'open';
}
