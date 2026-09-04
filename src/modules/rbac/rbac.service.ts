import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { AssignRoleDto } from './dto/assign-role.dto';

/**
 * Fine-grained permissions for VENUE OWNER STAFF sub-roles only
 * (e.g. "receptionist: check-in + calendar only" — §6). The four
 * top-level roles (player/owner/staff/admin) are a plain UserRole[]
 * on User and are checked by @Roles(), not this table.
 */
@Injectable()
export class RbacService {
  static readonly PERMISSION_CATALOG = [
    { key: 'bookings.view', descriptionEn: 'View bookings' },
    { key: 'bookings.checkin', descriptionEn: 'Check in a booking via QR' },
    { key: 'calendar.view', descriptionEn: 'View the venue calendar' },
    { key: 'calendar.manage', descriptionEn: 'Block slots / create walk-in bookings' },
    { key: 'venue.manage', descriptionEn: 'Edit venue/court/pricing' },
    { key: 'promotions.manage', descriptionEn: 'Create/edit promotions' },
    { key: 'finance.view', descriptionEn: 'View earnings/payouts' },
    { key: 'staff.manage', descriptionEn: 'Invite/remove staff' },
  ];

  constructor(private readonly prisma: PrismaService) {}

  async ensurePermissionCatalog(): Promise<void> {
    for (const p of RbacService.PERMISSION_CATALOG) {
      await this.prisma.permission.upsert({
        where: { key: p.key },
        update: {},
        create: p,
      });
    }
  }

  async createRole(ownerId: string, dto: CreateRoleDto) {
    const permissions = await this.prisma.permission.findMany({
      where: { key: { in: dto.permissionKeys } },
    });
    return this.prisma.role.create({
      data: {
        ownerId,
        name: dto.name,
        permissions: { create: permissions.map((p) => ({ permissionId: p.id })) },
      },
      include: { permissions: { include: { permission: true } } },
    });
  }

  listRoles(ownerId: string) {
    return this.prisma.role.findMany({
      where: { ownerId },
      include: { permissions: { include: { permission: true } } },
    });
  }

  async assignRole(ownerId: string, dto: AssignRoleDto) {
    const role = await this.prisma.role.findFirst({ where: { id: dto.roleId, ownerId } });
    if (!role) throw new NotFoundException('Role not found for this owner account');
    return this.prisma.userRoleAssignment.create({
      data: { userId: dto.userId, roleId: dto.roleId, venueId: dto.venueId },
    });
  }

  async revokeAssignment(ownerId: string, assignmentId: string) {
    const assignment = await this.prisma.userRoleAssignment.findUnique({
      where: { id: assignmentId },
      include: { role: true },
    });
    if (!assignment || assignment.role.ownerId !== ownerId) {
      throw new NotFoundException('Assignment not found');
    }
    return this.prisma.userRoleAssignment.delete({ where: { id: assignmentId } });
  }

  listPermissions() {
    return this.prisma.permission.findMany();
  }
}
