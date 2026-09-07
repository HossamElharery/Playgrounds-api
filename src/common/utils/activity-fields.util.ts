/**
 * Converts the generic per-sport dynamic-field bag captured by Partner
 * Onboarding (§20.4/§3.4 — free-form key/value strings, one schema per
 * sport in the frontend's `partner-sports.config.ts`) into the structured
 * `Court.gamingConfig` / `Court.tableConfig` / `Court.ageRating` columns for
 * the gaming-expansion sports. Other sports keep using the raw `spec` blob
 * as before — this is purely additive.
 */
export interface ActivityFields {
  gamingConfig?: Record<string, unknown>;
  tableConfig?: Record<string, unknown>;
  ageRating?: string;
}

export function buildActivityFields(
  activityKind: string | null | undefined,
  spec: Record<string, unknown> | null | undefined,
): ActivityFields {
  if (!spec) return {};
  const str = (key: string) =>
    typeof spec[key] === 'string' ? spec[key] : undefined;
  const isYes = (key: string) => str(key) === 'yes';

  if (activityKind === 'gaming-station') {
    return {
      gamingConfig: {
        consoleType: str('consoleType') ?? 'ps5',
        seats: Number(spec['seats']) || 4,
        roomTier: str('roomTier') ?? 'standard',
      },
      ageRating: str('ageRating') ?? 'everyone',
    };
  }

  if (activityKind === 'table-game') {
    const tableType = str('tableType');
    return {
      tableConfig: {
        ...(tableType ? { tableType } : {}),
        rentalAvailable: isYes('cueRental') || isYes('paddleRental'),
      },
    };
  }

  return {};
}
