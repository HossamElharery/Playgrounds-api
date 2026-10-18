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
