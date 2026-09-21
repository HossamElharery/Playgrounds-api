import { TeamService, type TeamActor } from './team.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';

const owner: AuthenticatedUser = { id: 'owner-1', phone: '', name: 'Owner', roles: ['owner'] };
const admin: AuthenticatedUser = { id: 'admin-1', phone: '', name: 'Admin', roles: ['admin'] };
const stranger: AuthenticatedUser = { id: 'owner-2', phone: '', name: 'Other', roles: ['owner'] };

function build() {
  const members = new Map<string, any>();
  const users = new Map<string, any>();
  let seq = 0;
  const tx: any = {
    user: {
      create: jest.fn(async ({ data }: any) => {
        const u = { id: `u${++seq}`, status: 'active', lastSeenAt: null, ...data };
        users.set(u.id, u);
        return u;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const u = users.get(where.id);
        Object.assign(u, data.roles ? { ...data, roles: data.roles.set } : data);
        return u;
      }),
    },
    staffMember: {
      create: jest.fn(async ({ data }: any) => {
        const m = { id: `s${++seq}`, createdAt: new Date(), ...data };
        members.set(m.id, m);
        return m;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(members.get(where.id), data)),
      delete: jest.fn(async ({ where }: any) => members.delete(where.id)),
    },
    refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    auditLogEntry: { create: jest.fn().mockResolvedValue({}) },
  };
  const withUser = (m: any) => (m ? { ...m, user: users.get(m.userId) } : null);
  const prisma: any = {
    ...tx,
    venue: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id === 'v1' ? { ownerId: 'owner-1' } : where.id === 'v9' ? { ownerId: 'owner-2' } : null,
      ),
      findMany: jest.fn().mockResolvedValue([{ id: 'v1' }, { id: 'v2' }]),
    },
    user: {
      ...tx.user,
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id === 'owner-1') return { countryCode: 'EG' };
        return [...users.values()].find((u) => (where.email && u.email === where.email) || (where.username && u.username === where.username)) ?? null;
      }),
    },
    staffMember: {
      ...tx.staffMember,
      findUnique: jest.fn(async ({ where }: any) => withUser(where.id ? members.get(where.id) : [...members.values()].find((m) => m.userId === where.userId))),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => withUser(members.get(where.id))),
      findMany: jest.fn(async () => [...members.values()].map(withUser)),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const realtime = { disconnectUser: jest.fn() };
  const svc = new TeamService(prisma, { get: () => 4 } as never, realtime as never);
  return { svc, prisma, tx, members, users, realtime };
}

const base = { name: 'Mohamed', email: 'Mo@Example.com', password: 'secret1', permissions: ['bookings.create'] };

describe('TeamService', () => {
  it('a manager creates a login with any email and any password — no verification step', async () => {
    const { svc, users, members } = build();
    const actor = await svc.resolveActor(owner);
    const created = await svc.create(actor, base);
    const user = [...users.values()][0];
    expect(user.email).toBe('mo@example.com');
    expect(user.roles).toEqual(['staff']);
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(user.passwordHash).toBeTruthy();
    expect(user.passwordHash).not.toBe('secret1');
    // "create bookings" pulled in "see bookings"; no venue list given = every venue of the owner.
    expect([...members.values()][0]).toMatchObject({ ownerId: 'owner-1', permissions: ['bookings.view', 'bookings.create'], venueIds: ['v1', 'v2'] });
    expect(created).not.toHaveProperty('passwordHash');
  });

  it('accepts a username instead of an email, and rejects a badly formed one', async () => {
    const { svc } = build();
    const actor = await svc.resolveActor(owner);
    await expect(svc.create(actor, { ...base, email: undefined, username: 'reception.1' })).resolves.toBeDefined();
    await expect(svc.create(actor, { ...base, email: undefined, username: '1abc' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'USERNAME_INVALID' }) });
    await expect(svc.create(actor, { ...base, email: undefined })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'LOGIN_REQUIRED' }) });
  });

  it('refuses a duplicate email or an empty permission set', async () => {
    const { svc } = build();
    const actor = await svc.resolveActor(owner);
    await svc.create(actor, base);
    await expect(svc.create(actor, base)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'EMAIL_TAKEN' }) });
    await expect(svc.create(actor, { ...base, email: 'x@y.com', permissions: ['nope'] })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PERMISSIONS_REQUIRED' }),
    });
  });

  it('cannot give staff a venue that is not the owner’s', async () => {
    const { svc } = build();
    const actor = await svc.resolveActor(owner);
    await expect(svc.create(actor, { ...base, venueIds: ['v-foreign'] })).rejects.toThrow('not available');
  });

  it('the admin acts on any organisation through a venue, and a stranger cannot', async () => {
    const { svc } = build();
    await expect(svc.resolveActor(admin)).rejects.toThrow('venueId is required');
    await expect(svc.resolveActor(admin, 'v1')).resolves.toMatchObject({ kind: 'admin', ownerId: 'owner-1' });
    await expect(svc.resolveActor(stranger, 'v1')).rejects.toThrow('Not your venue');
  });

  it('changes permissions and venues, and ends open sessions when the password is reset', async () => {
    const { svc, tx, members } = build();
    const actor = await svc.resolveActor(owner);
    const created = await svc.create(actor, base);
    await svc.update(actor, created.id, { permissions: ['reports.view'], venueIds: ['v2'], password: 'newsecret' });
    expect([...members.values()][0]).toMatchObject({ permissions: ['reports.view'], venueIds: ['v2'] });
    expect(tx.refreshToken.updateMany).toHaveBeenCalled();
    const audit = tx.auditLogEntry.create.mock.calls.at(-1)[0].data;
    expect(audit.action).toBe('team.member.updated');
    expect(JSON.stringify(audit.metadata)).not.toContain('newsecret');
  });

  it('suspending revokes sessions; removing frees the login and ends access', async () => {
    const { svc, tx, members, users } = build();
    const actor = await svc.resolveActor(owner);
    const created = await svc.create(actor, base);
    await svc.update(actor, created.id, { status: 'suspended' });
    expect([...users.values()][0].status).toBe('suspended');
    expect(tx.refreshToken.updateMany).toHaveBeenCalledTimes(1);
    await svc.remove(actor, created.id);
    expect(members.size).toBe(0);
    expect([...users.values()][0]).toMatchObject({ status: 'banned', passwordHash: null, email: null, username: null, roles: ['player'] });
  });

  it('a staff member of another organisation looks like a missing one', async () => {
    const { svc } = build();
    const actor = await svc.resolveActor(owner);
    const created = await svc.create(actor, base);
    const other: TeamActor = { kind: 'owner', userId: 'owner-2', ownerId: 'owner-2', scope: null };
    await expect(svc.update(other, created.id, { name: 'Hacked' })).rejects.toThrow('not found');
    await expect(svc.remove(other, created.id)).rejects.toThrow('not found');
  });

  describe('a delegated manager (staff with team.manage)', () => {
    const manager = (perms: string[], venues = ['v1']): TeamActor => ({
      kind: 'staff',
      userId: 'mgr',
      ownerId: 'owner-1',
      scope: { staffId: 'sm', ownerId: 'owner-1', permissions: perms, venueIds: venues, title: null },
    });

    it('cannot grant a permission he does not hold', async () => {
      const { svc } = build();
      await expect(svc.create(manager(['team.manage', 'bookings.view']), { ...base, permissions: ['reports.view'] })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'CANNOT_GRANT' }),
      });
    });

    it('cannot hand out a venue outside his own list', async () => {
      const { svc } = build();
      await expect(
        svc.create(manager(['team.manage', 'bookings.view']), { ...base, permissions: ['bookings.view'], venueIds: ['v2'] }),
      ).rejects.toThrow('not available');
    });

    it('cannot edit or remove someone who holds more than he does, nor himself', async () => {
      const { svc, prisma } = build();
      const boss = await svc.create(await svc.resolveActor(owner), { ...base, email: 'boss@x.com', permissions: ['reports.view', 'bookings.view'] });
      const mgr = manager(['team.manage', 'bookings.view']);
      await expect(svc.update(mgr, boss.id, { title: 'x' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ABOVE_YOUR_LEVEL' }) });
      await expect(svc.remove(mgr, boss.id)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ABOVE_YOUR_LEVEL' }) });
      const self = await svc.create(await svc.resolveActor(owner), { ...base, email: 'me@x.com', permissions: ['bookings.view'] });
      await expect(svc.update({ ...mgr, userId: (await prisma.staffMember.findUnique({ where: { id: self.id } })).userId }, self.id, { title: 'x' })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'CANNOT_EDIT_SELF' }),
      });
    });
  });

  it('suspending or removing staff drops their live sockets, not just their tokens', async () => {
    const { svc, realtime } = build();
    const actor = await svc.resolveActor(owner);
    await svc.create(actor, base);
    const member = (await (svc as any).prisma.staffMember.findMany())[0];
    await svc.update(actor, member.id, { status: 'suspended' } as never);
    expect(realtime.disconnectUser).toHaveBeenCalledWith(member.userId);
    realtime.disconnectUser.mockClear();
    await svc.remove(actor, member.id);
    expect(realtime.disconnectUser).toHaveBeenCalledWith(member.userId);
  });
});
