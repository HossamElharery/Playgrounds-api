import { SquadService } from './squad.service';

describe('SquadService invite links', () => {
  const linkRow = { id: 'link-1', squadId: 'sq-1', expiresAt: new Date(Date.now() + 60_000) };
  const prisma: any = {
    squadInviteLink: { findUnique: jest.fn() },
    squadMember: { findMany: jest.fn() },
  };
  const config: any = { get: (k: string) => (k === 'JWT_ACCESS_SECRET' ? 'test-secret' : undefined) };
  const service = new SquadService(prisma, {} as any, {} as any, {} as any, config);
  const tokenFor = (id: string) => (service as any).linkTokenFor(id) as string;

  beforeEach(() => {
    prisma.squadInviteLink.findUnique.mockReset();
    prisma.squadMember.findMany.mockReset();
  });

  it('rejects malformed and forged tokens without touching the database', async () => {
    for (const bad of ['', 'abc', 'link-1.', 'link-1.forged', `${tokenFor('link-1')}.x`, 'x'.repeat(500)]) {
      await expect(service.previewInviteLink(bad)).rejects.toMatchObject({ status: 404 });
    }
    expect(prisma.squadInviteLink.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a validly signed token whose link is gone or expired', async () => {
    prisma.squadInviteLink.findUnique.mockResolvedValueOnce(null);
    await expect(service.previewInviteLink(tokenFor('link-1'))).rejects.toMatchObject({ status: 404 });
    prisma.squadInviteLink.findUnique.mockResolvedValueOnce({ ...linkRow, expiresAt: new Date(Date.now() - 1) });
    await expect(service.previewInviteLink(tokenFor('link-1'))).rejects.toMatchObject({ status: 404 });
  });

  it('previews a live link with leader name and fullness', async () => {
    prisma.squadInviteLink.findUnique.mockResolvedValue(linkRow);
    prisma.squadMember.findMany.mockResolvedValue([
      { isLeader: false, user: { name: 'Sam' } },
      { isLeader: true, user: { name: 'Lee' } },
    ]);
    await expect(service.previewInviteLink(tokenFor('link-1'))).resolves.toEqual({
      leaderName: 'Lee',
      memberCount: 2,
      maxSize: 7,
      full: false,
    });
  });
});
