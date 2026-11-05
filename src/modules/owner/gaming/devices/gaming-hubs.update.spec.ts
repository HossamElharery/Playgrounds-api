import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HubRpcError } from './console-hub.service';
import { GamingHubsService } from './gaming-hubs.service';

const SHA = 'a'.repeat(64);

describe('asking a Hub to update', () => {
  let dir: string;
  let call: jest.Mock;
  let service: GamingHubsService;
  const user = { id: 'u1', roles: ['owner'] } as never;
  const dto = { venueId: 'v1', requestKey: 'k' } as never;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-release-'));
    fs.writeFileSync(
      path.join(dir, 'latest.json'),
      JSON.stringify({
        version: '1.0.5',
        files: { 'win32-x64': { sha256: SHA, size: 10 } },
      }),
    );
    call = jest.fn();
    const prisma = {
      gamingHub: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'h1', hubVersion: '1.0.4' }),
      },
    };
    const commands = { access: jest.fn().mockResolvedValue(undefined) };
    const config = {
      get: (k: string) =>
        k === 'HUB_RELEASE_DIR'
          ? dir
          : k === 'HUB_DOWNLOAD_BASE'
            ? 'https://dl.example.test/hub'
            : undefined,
    };
    service = new GamingHubsService(
      prisma as never,
      { call, isOnline: () => true } as never,
      commands as never,
      config as never,
    );
    service.updateAckMs = 40;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      const r = (
        e as { getResponse?: () => { code?: string } }
      ).getResponse?.();
      return {
        code: r?.code,
        status: (e as { getStatus?: () => number }).getStatus?.(),
      };
    }
    throw new Error('expected a refusal');
  };

  it('the hub answers quickly: done', async () => {
    call.mockResolvedValue({ version: '1.0.5' });
    await expect(service.update(user, 'h1', dto)).resolves.toEqual({
      ok: true,
      state: 'done',
    });
    expect(call).toHaveBeenCalledWith('h1', 'update', {}, 150_000);
  });

  it('a slow download does not hold the request: "working", and the late answer is not an unhandled error', async () => {
    let finish!: (v: unknown) => void;
    call.mockReturnValue(new Promise((r) => (finish = r)));
    await expect(service.update(user, 'h1', dto)).resolves.toEqual({
      ok: true,
      state: 'working',
    });
    finish({ version: '1.0.5' });
    await new Promise((r) => setTimeout(r, 10));
  });

  it('a late failure after "working" does not crash the server either', async () => {
    let fail!: (e: unknown) => void;
    call.mockReturnValue(new Promise((_r, rej) => (fail = rej)));
    await expect(service.update(user, 'h1', dto)).resolves.toMatchObject({
      state: 'working',
    });
    fail(new HubRpcError('HUB_OFFLINE', 'hub disconnected', true));
    await new Promise((r) => setTimeout(r, 10));
  });

  it('the hub restarts so its link drops before the answer: "restarting", not an error', async () => {
    call.mockRejectedValue(
      new HubRpcError('HUB_OFFLINE', 'hub disconnected', true),
    );
    await expect(service.update(user, 'h1', dto)).resolves.toEqual({
      ok: true,
      state: 'restarting',
    });
  });

  it('the hub took longer than the server waits: still "working"', async () => {
    call.mockRejectedValue(new HubRpcError('HUB_TIMEOUT', 'update timed out'));
    await expect(service.update(user, 'h1', dto)).resolves.toEqual({
      ok: true,
      state: 'working',
    });
  });

  it('the hub is already running its own scheduled update: same as ours', async () => {
    call.mockRejectedValue(
      new HubRpcError('UPDATE_FAILED', 'an update is already running'),
    );
    await expect(service.update(user, 'h1', dto)).resolves.toEqual({
      ok: true,
      state: 'working',
    });
  });

  it('a hub that is not connected at all is refused clearly (409 HUB_OFFLINE)', async () => {
    call.mockRejectedValue(new HubRpcError('HUB_OFFLINE', 'hub offline'));
    expect(await code(service.update(user, 'h1', dto))).toEqual({
      code: 'HUB_OFFLINE',
      status: 409,
    });
  });

  it('a real hub-side failure is still reported', async () => {
    call.mockRejectedValue(
      new HubRpcError('UPDATE_FAILED', 'download failed the integrity check'),
    );
    const r = await code(service.update(user, 'h1', dto));
    expect(r.status).toBe(400);
  });

  it('nothing newer: UPDATE_NOT_AVAILABLE, and the hub is never asked', async () => {
    fs.writeFileSync(
      path.join(dir, 'latest.json'),
      JSON.stringify({
        version: '1.0.4',
        files: { 'win32-x64': { sha256: SHA, size: 10 } },
      }),
    );
    expect(await code(service.update(user, 'h1', dto))).toEqual({
      code: 'UPDATE_NOT_AVAILABLE',
      status: 400,
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('the request is answered within the wait, not after the long hub timeout', async () => {
    call.mockReturnValue(new Promise(() => undefined));
    const started = Date.now();
    await service.update(user, 'h1', dto);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
