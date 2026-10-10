import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { GamingSetupDto, SetupKind } from '../owner/gaming/gaming-setup.dto';
import { GamingLayoutService } from '../owner/gaming/gaming-layout.service';
import {
  buildSetupLayout,
  PlannedUnit,
  validateSetupPlan,
} from '../owner/gaming/setup-plan';
import { gamingConfigObject } from '../owner/gaming/gaming-tariff';
import { isoMoneyScale, rescaleMoney } from '../../common/money/money-scale';
export type RegistrationGamingPlan = Pick<
  GamingSetupDto,
  'groups' | 'rooms' | 'floorCount' | 'arrangement' | 'ambience' | 'language'
>;
export function validateRegistrationGamingPlan(
  plan: RegistrationGamingPlan,
): void {
  const full = plainToInstance(GamingSetupDto, {
    ...plan,
    venueId: '00000000-0000-4000-8000-000000000001',
    requestKey: '00000000-0000-4000-8000-000000000002',
    expectedRevision: 0,
    reuseExisting: true,
    existingUnits: undefined,
  });
  try {
    if (validateSync(full).length) throw new Error();
    validateSetupPlan(full);
  } catch {
    throw new BadRequestException({
      code: 'REGISTRATION_GAMING_SETUP_INVALID',
    });
  }
}
/** Approval uses the already-created physical inventory, never another batch of devices. */
export async function publishRegistrationGamingPlan(
  tx: Prisma.TransactionClient,
  venueId: string,
  currency: string,
  actorId: string,
  plan: RegistrationGamingPlan,
  units: { id: string; assetKey: SetupKind }[],
  layouts: GamingLayoutService,
) {
  validateRegistrationGamingPlan(plan);
  const current = await tx.gamingLayout.findUnique({ where: { venueId } });
  if (current?.revision)
    throw new BadRequestException({ code: 'SETUP_ALREADY_CONFIGURED' });
  if (
    units.length !== plan.groups.reduce((n, g) => n + g.count, 0) ||
    plan.groups.some(
      (g) => units.filter((u) => u.assetKey === g.assetKey).length !== g.count,
    )
  )
    throw new BadRequestException({
      code: 'REGISTRATION_GAMING_INVENTORY_MISMATCH',
    });
  const planned: PlannedUnit[] = [],
    used = new Set<string>();
  const tariff = async (
    id: string,
    asset: SetupKind,
    rate: number,
    multi: number | undefined,
    roomIndex?: number,
    parent = false,
  ) => {
    const unit = await tx.court.findUniqueOrThrow({ where: { id } }),
      table = ['billiards', 'table-tennis'].includes(asset);
    const whole =
      roomIndex !== undefined &&
      !parent &&
      plan.rooms[roomIndex].occupancy === 'exclusive';
    const config: Record<string, unknown> = table
      ? { ...gamingConfigObject(unit.tableConfig), setupWholeRoomOnly: whole }
      : {
          ...gamingConfigObject(unit.gamingConfig),
          consoleType: asset,
          seats: multi ? 4 : 2,
          roomTier: roomIndex === undefined ? 'standard' : 'vip-big-screen',
          setupWholeRoomOnly: whole,
        };
    if (!table) {
      if (multi !== undefined) config.multiHourlyRateMinor = multi;
      else delete config.multiHourlyRateMinor;
    }
    await tx.court.update({
      where: { id },
      data: {
        gamingHourlyRateMinor: rate,
        gamingPublished: !whole,
        ...(table
          ? { tableConfig: config as Prisma.InputJsonValue }
          : { gamingConfig: config as Prisma.InputJsonValue }),
      },
    });
    await tx.pricingRule.deleteMany({ where: { courtId: id, label: 'base' } });
    await tx.pricingRule.create({
      data: {
        courtId: id,
        label: 'base',
        daysOfWeek: [],
        startTime: '00:00',
        endTime: '24:00',
        priceAmount: Math.round(
          rescaleMoney(rate, isoMoneyScale(currency), 100),
        ),
        currency,
      },
    });
  };
  for (const g of plan.groups) {
    const take = () => {
      const u = units.find((u) => u.assetKey === g.assetKey && !used.has(u.id));
      if (!u)
        throw new BadRequestException({
          code: 'REGISTRATION_GAMING_INVENTORY_MISMATCH',
        });
      used.add(u.id);
      return u.id;
    };
    for (let ri = 0; ri < plan.rooms.length; ri++) {
      const room = plan.rooms[ri],
        count = room.members.find((m) => m.assetKey === g.assetKey)?.count ?? 0;
      for (let i = 0; i < count; i++) {
        const id = take();
        await tariff(
          id,
          g.assetKey,
          g.privateHourlyRateMinor ?? g.hourlyRateMinor,
          g.privateMultiHourlyRateMinor ?? g.multiHourlyRateMinor,
          ri,
        );
        planned.push({
          id,
          assetKey: g.assetKey,
          floorIndex: room.floorIndex,
          roomIndex: ri,
        });
      }
    }
    const remaining =
        g.count -
        plan.rooms.reduce(
          (n, r) =>
            n + (r.members.find((m) => m.assetKey === g.assetKey)?.count ?? 0),
          0,
        ),
      floors =
        g.floorCounts ??
        Array.from({ length: plan.floorCount }, (_, i) =>
          i === g.floorIndex ? remaining : 0,
        );
    for (let f = 0; f < floors.length; f++)
      for (let i = 0; i < floors[f]; i++) {
        const id = take();
        await tariff(id, g.assetKey, g.hourlyRateMinor, g.multiHourlyRateMinor);
        planned.push({ id, assetKey: g.assetKey, floorIndex: f });
      }
  }
  for (let ri = 0; ri < plan.rooms.length; ri++) {
    const room = plan.rooms[ri];
    if (room.occupancy !== 'exclusive') continue;
    const asset = room.members[0].assetKey,
      source = await tx.court.findUniqueOrThrow({
        where: { id: units.find((u) => u.assetKey === asset)!.id },
      });
    const parent = await tx.court.create({
      data: {
        venueId,
        sportId: source.sportId,
        name: room.name,
        slotDurationMins: 60,
        gamingConfig: source.gamingConfig ?? Prisma.JsonNull,
        tableConfig: source.tableConfig ?? Prisma.JsonNull,
      },
    });
    await tariff(
      parent.id,
      asset,
      room.hourlyRateMinor!,
      room.multiHourlyRateMinor,
      ri,
      true,
    );
    planned.push({
      id: parent.id,
      assetKey: asset,
      floorIndex: room.floorIndex,
      roomIndex: ri,
      roomParent: true,
    });
  }
  const full = {
    ...plan,
    venueId,
    requestKey: randomUUID(),
    expectedRevision: 0,
    reuseExisting: true,
  };
  const document = buildSetupLayout(full, planned, randomUUID);
  await layouts.applyRooms(tx, venueId, document);
  await tx.gamingLayoutRevision.create({
    data: {
      venueId,
      revision: 1,
      document: document as unknown as Prisma.InputJsonValue,
      requestKey: full.requestKey,
      requestHash: 'registration-setup',
      createdById: actorId,
    },
  });
  await tx.gamingLayout.upsert({
    where: { venueId },
    create: { venueId, revision: 1 },
    update: { revision: 1, draft: Prisma.DbNull },
  });
}
