import { Subject } from 'rxjs';
import { CallsService } from './calls.service';
import {
  CALL_PUSH_DELAY_MS,
  CALL_RING_MS,
  MAX_MUTE_MINUTES,
} from './calls.constants';

type Row = Record<string, any>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((c) => matches(row, c));
    if (key === 'AND') return (cond as Row[]).every((c) => matches(row, c));
    const value = row[key];
    if (
      cond &&
      typeof cond === 'object' &&
      !(cond instanceof Date) &&
      !Array.isArray(cond)
    ) {
      return Object.entries(cond).every(([op, arg]) => {
        const a = value instanceof Date ? value.getTime() : value;
        const b = arg instanceof Date ? arg.getTime() : arg;
        if (op === 'gt') return a != null && a > (b as number);
        if (op === 'lt') return a != null && a < (b as number);
        if (op === 'in') return (arg as unknown[]).includes(value);
        if (op === 'notIn') return !(arg as unknown[]).includes(value);
        if (op === 'has') return Array.isArray(value) && value.includes(arg);
        if (op === 'contains')
          return (
            typeof value === 'string' &&
            value.toLowerCase().includes(String(arg).toLowerCase())
          );
        if (op === 'mode') return true;
        return false;
      });
    }
    if (cond instanceof Date)
      return value instanceof Date && value.getTime() === cond.getTime();
    return value === cond;
  });
}

function table(initial: Row[] = [], defaults: () => Row = () => ({})) {
  const rows: Row[] = initial;
  let n = 0;
  const flat = (where: Row = {}) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(where)) {
      if (v && typeof v === 'object' && !(v instanceof Date) && k.includes('_'))
        Object.assign(out, v);
      else out[k] = v;
    }
    return out;
  };
  const api = {
    rows,
    findUnique: async ({ where }: Row) =>
      rows.find((r) => matches(r, flat(where))) ?? null,
    findUniqueOrThrow: async ({ where }: Row) => {
      const row = rows.find((r) => matches(r, flat(where)));
      if (!row) throw new Error('not found');
      return row;
    },
    findFirst: async ({ where }: Row = {}) =>
      rows.find((r) => matches(r, where)) ?? null,
    findMany: async ({ where, orderBy, take }: Row = {}) => {
      let out = rows.filter((r) => matches(r, where));
      if (orderBy?.createdAt === 'desc')
        out = [...out].sort((a, b) => b.createdAt - a.createdAt);
      return take ? out.slice(0, take) : out;
    },
    count: async ({ where }: Row = {}) =>
      rows.filter((r) => matches(r, where)).length,
    create: async ({ data }: Row) => {
      const row = {
        id: `id-${++n}`,
        createdAt: new Date(),
        answeredAt: null,
        endedAt: null,
        endReason: null,
        seenAt: null,
        ...defaults(),
        ...data,
      };
      rows.push(row);
      return row;
    },
    updateMany: async ({ where, data }: Row) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
    deleteMany: async ({ where }: Row = {}) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
      return { count: hit.length };
    },
    upsert: async ({ where, update, create }: Row) => {
      const row = rows.find((r) => matches(r, flat(where)));
      if (row) return Object.assign(row, update);
      return api.create({ data: create });
    },
  };
  return api;
}

const OWNER = 'owner-1';
const ALICE = 'staff-alice';
const BOB = 'staff-bob';
const OUTSIDER = 'staff-other-org';
const ADMIN = 'admin-1';

function setup(env: Record<string, string> = { STAFF_CALLS_ENABLED: 'true' }) {
  const user = table([
    {
      id: OWNER,
      name: 'Owner',
      email: 'owner@matchena.com',
      avatarUrl: null,
      roles: ['owner'],
      status: 'active',
      isGuest: false,
      lastSeenAt: null,
      preferredLang: 'ar',
    },
    {
      id: ALICE,
      name: 'Alice',
      avatarUrl: null,
      roles: ['staff'],
      status: 'active',
      isGuest: false,
      lastSeenAt: null,
      preferredLang: 'ar',
    },
    {
      id: BOB,
      name: 'Bob',
      avatarUrl: null,
      roles: ['staff'],
      status: 'active',
      isGuest: false,
      lastSeenAt: null,
      preferredLang: 'en',
    },
    {
      id: OUTSIDER,
      name: 'Eve',
      avatarUrl: null,
      roles: ['staff'],
      status: 'active',
      isGuest: false,
      lastSeenAt: null,
      preferredLang: 'ar',
    },
    {
      id: 'admin-1',
      name: 'Hossam',
      avatarUrl: null,
      roles: ['admin'],
      status: 'active',
      isGuest: false,
      lastSeenAt: null,
      preferredLang: 'ar',
    },
    {
      id: 'player-1',
      name: 'Pat',
      avatarUrl: null,
      roles: ['player'],
      status: 'active',
      isGuest: false,
      lastSeenAt: null,
      preferredLang: 'ar',
    },
  ]);
  const staffMember = table([
    { userId: ALICE, ownerId: OWNER, title: 'Reception', venueIds: ['v1'] },
    { userId: BOB, ownerId: OWNER, title: null, venueIds: [] },
    { userId: OUTSIDER, ownerId: 'owner-2', title: null, venueIds: [] },
  ]);
  const prisma = {
    user,
    staffMember,
    staffCall: table(),
    callMute: table(),
    callSettings: table(),
    venue: table([
      { id: 'v1', ownerId: OWNER, nameAr: 'ملعب النصر', nameEn: 'Nasr Arena' },
      {
        id: 'v2',
        ownerId: OWNER,
        nameAr: 'ملعب الشروق',
        nameEn: 'Shorouk Court',
      },
    ]),
  };
  const online = new Set<string>();
  const presence = {
    connection$: new Subject<{ userId: string; connected: boolean }>(),
    isReachable: (id: string) => online.has(id),
    isOnline: (id: string) => online.has(id),
  };
  const emitted: { to: string; event: Row }[] = [];
  const emitter = {
    emitToUser: (to: string, event: Row) => emitted.push({ to, event }),
  };
  const notifications = { create: jest.fn().mockResolvedValue({}) };
  const fcm = { sendCall: jest.fn().mockResolvedValue(undefined) };
  const webPush = { sendCall: jest.fn().mockResolvedValue(undefined) };
  const squad = { iceServers: jest.fn().mockReturnValue({ iceServers: [] }) };
  const service = new CallsService(
    prisma as never,
    { get: (k: string) => env[k] } as never,
    presence as never,
    emitter as never,
    notifications as never,
    fcm as never,
    webPush as never,
    squad as never,
  );
  const eventsTo = (id: string, type: string) =>
    emitted.filter((e) => e.to === id && e.event['type'] === type);
  return {
    service,
    prisma,
    online,
    presence,
    emitted,
    eventsTo,
    notifications,
    fcm,
    webPush,
  };
}

describe('CallsService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  describe('who may call whom', () => {
    it('is off until STAFF_CALLS_ENABLED=true', async () => {
      const { service } = setup({});
      await expect(service.directory(OWNER)).resolves.toMatchObject({
        enabled: false,
        members: [],
      });
      await expect(service.create(OWNER, ALICE)).rejects.toMatchObject({
        status: 404,
      });
    });

    it('lists the owner and the colleagues of the same organisation only, never yourself or other orgs', async () => {
      const { service } = setup();
      const forAlice = await service.directory(ALICE);
      expect(forAlice.enabled).toBe(true);
      expect(forAlice.members.map((m) => m.id).sort()).toEqual(
        [BOB, OWNER].sort(),
      );
      expect(forAlice.members.find((m) => m.id === OWNER)).toMatchObject({
        role: 'owner',
      });
      const forOwner = await service.directory(OWNER);
      expect(forOwner.members.map((m) => m.id).sort()).toEqual(
        [ALICE, BOB].sort(),
      );
    });

    it('gives players and strangers no directory and no calls', async () => {
      const { service } = setup();
      await expect(service.directory('player-1')).resolves.toMatchObject({
        enabled: false,
      });
      await expect(service.create('player-1', OWNER)).rejects.toMatchObject({
        status: 403,
      });
      await expect(service.create(OUTSIDER, ALICE)).rejects.toMatchObject({
        status: 404,
      });
      await expect(service.create(OWNER, OUTSIDER)).rejects.toMatchObject({
        status: 404,
      });
    });

    it('refuses calling yourself, suspended people and guests', async () => {
      const { service, prisma } = setup();
      await expect(service.create(ALICE, ALICE)).rejects.toMatchObject({
        status: 400,
      });
      prisma.user.rows.find((u) => u.id === BOB)!['status'] = 'suspended';
      await expect(service.create(ALICE, BOB)).rejects.toMatchObject({
        status: 404,
      });
      prisma.user.rows.find((u) => u.id === OWNER)!['isGuest'] = true;
      await expect(service.create(ALICE, OWNER)).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('ringing', () => {
    it('rings online callees through the socket and pushes only if nobody confirms in time', async () => {
      const { service, online, eventsTo, fcm, webPush } = setup();
      online.add(ALICE);
      const { call } = await service.create(OWNER, ALICE);
      expect(call).toMatchObject({
        status: 'ringing',
        direction: 'out',
        peer: { id: ALICE, title: 'Reception' },
      });
      expect(eventsTo(ALICE, 'call.incoming')).toHaveLength(1);
      expect(eventsTo(ALICE, 'call.incoming')[0].event['from']).toMatchObject({
        id: OWNER,
        role: 'owner',
      });
      expect(fcm.sendCall).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(CALL_PUSH_DELAY_MS + 5);
      expect(fcm.sendCall).toHaveBeenCalledWith(
        ALICE,
        expect.objectContaining({ kind: 'ring', callId: call.id }),
      );
      expect(webPush.sendCall).toHaveBeenCalledTimes(1);
    });

    it('does not push at all when the native app confirms it is ringing', async () => {
      const { service, online, eventsTo, fcm, webPush } = setup();
      online.add(ALICE);
      const { call } = await service.create(OWNER, ALICE);
      await service.markRinging(ALICE, call.id, true);
      await jest.advanceTimersByTimeAsync(CALL_PUSH_DELAY_MS + 5);
      expect(fcm.sendCall).not.toHaveBeenCalled();
      expect(webPush.sendCall).not.toHaveBeenCalled();
      expect(eventsTo(OWNER, 'call.ringing')).toHaveLength(1);
    });

    it('still rings the phone but skips the browser toast when only an open tab confirmed', async () => {
      const { service, online, fcm, webPush } = setup();
      online.add(ALICE);
      const { call } = await service.create(OWNER, ALICE);
      await service.markRinging(ALICE, call.id, false);
      await jest.advanceTimersByTimeAsync(CALL_PUSH_DELAY_MS + 5);
      expect(fcm.sendCall).toHaveBeenCalledTimes(1);
      expect(webPush.sendCall).not.toHaveBeenCalled();
    });

    it('pushes an offline callee immediately', async () => {
      const { service, fcm } = setup();
      await service.create(OWNER, ALICE);
      await jest.advanceTimersByTimeAsync(1);
      expect(fcm.sendCall).toHaveBeenCalledTimes(1);
    });

    it('only the callee can confirm ringing', async () => {
      const { service, online, eventsTo } = setup();
      online.add(ALICE);
      const { call } = await service.create(OWNER, ALICE);
      await service.markRinging(BOB, call.id, true);
      await service.markRinging(OWNER, call.id, true);
      expect(eventsTo(OWNER, 'call.ringing')).toHaveLength(0);
    });

    it('becomes a missed call after 45 s, tells both sides and leaves a notice (with a replacing push)', async () => {
      const { service, prisma, eventsTo, notifications, fcm } = setup();
      const { call } = await service.create(OWNER, ALICE);
      await service.markRinging(ALICE, call.id, false);
      await jest.advanceTimersByTimeAsync(CALL_RING_MS + 10);
      expect(prisma.staffCall.rows[0]).toMatchObject({
        status: 'missed',
        endReason: 'timeout',
      });
      expect(eventsTo(ALICE, 'call.ended')[0].event).toMatchObject({
        callId: call.id,
        status: 'missed',
      });
      expect(eventsTo(OWNER, 'call.ended')).toHaveLength(1);
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: ALICE,
          category: 'calls',
          noPush: true,
          dedupKey: `call-missed:${call.id}`,
        }),
      );
      expect(fcm.sendCall).toHaveBeenCalledWith(
        ALICE,
        expect.objectContaining({ kind: 'missed' }),
      );
    });

    it('a caller who hangs up while it rings leaves the callee a missed call', async () => {
      const { service, prisma, eventsTo, notifications } = setup();
      const { call } = await service.create(OWNER, ALICE);
      await service.markRinging(ALICE, call.id, false);
      await service.cancel(OWNER, call.id);
      expect(prisma.staffCall.rows[0]).toMatchObject({ status: 'cancelled' });
      expect(eventsTo(ALICE, 'call.ended')).toHaveLength(1);
      expect(notifications.create).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(CALL_RING_MS + 10);
      expect(prisma.staffCall.rows[0]['status']).toBe('cancelled');
    });

    it('does not invent a missed call when no device confirmed the ring', async () => {
      const { service, prisma, notifications, eventsTo } = setup();
      const { call } = await service.create(OWNER, ALICE);
      await jest.advanceTimersByTimeAsync(CALL_RING_MS + 10);
      expect(prisma.staffCall.rows[0]).toMatchObject({ status: 'failed', endReason: 'unreached' });
      expect(eventsTo(OWNER, 'call.ended')[0].event).toMatchObject({ status: 'failed', reason: 'unreached' });
      expect(notifications.create).not.toHaveBeenCalled();
      expect((await service.recent(ALICE)).items).toHaveLength(0);
      expect((await service.recent(OWNER)).items[0]).toMatchObject({ status: 'failed' });

      const another = await service.create(OWNER, ALICE);
      await service.cancel(OWNER, another.call.id);
      expect(prisma.staffCall.rows[1]).toMatchObject({ status: 'failed', endReason: 'unreached' });
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  describe('muting and do-not-disturb', () => {
    it('a muted caller is told "unavailable" and the callee is never bothered', async () => {
      const { service, prisma, emitted, fcm } = setup();
      await service.setMute(ALICE, OWNER, 60);
      const { call } = await service.create(OWNER, ALICE);
      expect(call.status).toBe('unavailable');
      expect(emitted).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(CALL_RING_MS + 10);
      expect(fcm.sendCall).not.toHaveBeenCalled();
      expect(prisma.staffCall.rows).toHaveLength(1);
      // The muted person does not see it in their own history; the callee never learns of it.
      await expect(service.recent(ALICE)).resolves.toMatchObject({ items: [] });
      await expect((await service.recent(OWNER)).items[0]).toMatchObject({
        status: 'unavailable',
        direction: 'out',
      });
    });

    it('the mute only silences that one person and ends by itself', async () => {
      const { service } = setup();
      await service.setMute(ALICE, OWNER, 60);
      expect((await service.create(BOB, ALICE)).call.status).toBe('ringing');
      await service.end(BOB, (await service.active(BOB)).current!.id);
      jest.setSystemTime(Date.now() + 61 * 60_000);
      expect((await service.create(OWNER, ALICE)).call.status).toBe('ringing');
    });

    it('caps a mute at 8 hours and lets you lift it', async () => {
      const { service, prisma } = setup();
      const { mutedUntil } = await service.setMute(ALICE, OWNER, 99_999);
      expect(Date.parse(mutedUntil) - Date.now()).toBeLessThanOrEqual(
        MAX_MUTE_MINUTES * 60_000,
      );
      await service.clearMute(ALICE, OWNER);
      expect(prisma.callMute.rows).toHaveLength(0);
    });

    it('cannot mute someone outside the organisation or yourself', async () => {
      const { service } = setup();
      await expect(service.setMute(ALICE, OUTSIDER, 60)).rejects.toMatchObject({
        status: 404,
      });
      await expect(service.setMute(ALICE, ALICE, 60)).rejects.toMatchObject({
        status: 404,
      });
    });

    it('do-not-disturb silences everybody until it is switched off', async () => {
      const { service } = setup();
      await service.setDnd(ALICE, 30);
      expect((await service.create(OWNER, ALICE)).call.status).toBe(
        'unavailable',
      );
      expect((await service.create(BOB, ALICE)).call.status).toBe(
        'unavailable',
      );
      await service.setDnd(ALICE, 0);
      expect((await service.create(OWNER, ALICE)).call.status).toBe('ringing');
    });

    it('shows a mute in the directory only to the person who set it', async () => {
      const { service } = setup();
      await service.setMute(ALICE, OWNER, 60);
      const mine = await service.directory(ALICE);
      expect(mine.members.find((m) => m.id === OWNER)?.mutedUntil).toBeTruthy();
      const theirs = await service.directory(OWNER);
      expect(theirs.members.find((m) => m.id === ALICE)?.mutedUntil).toBeNull();
    });
  });

  describe('busy lines', () => {
    it('a callee already in a call is busy; a caller already in a call cannot start another', async () => {
      const { service } = setup();
      await service.create(OWNER, ALICE);
      expect((await service.create(BOB, ALICE)).call.status).toBe('busy');
      await expect(service.create(OWNER, BOB)).rejects.toMatchObject({
        status: 409,
        response: { code: 'ALREADY_IN_CALL' },
      });
    });

    it('two people calling each other at the same moment get one call, not two', async () => {
      const { service, prisma } = setup();
      const [a, b] = await Promise.allSettled([
        service.create(OWNER, ALICE),
        service.create(ALICE, OWNER),
      ]);
      expect(a.status).toBe('fulfilled');
      expect(b.status).toBe('rejected');
      expect(
        prisma.staffCall.rows.filter((r) => r['status'] === 'ringing'),
      ).toHaveLength(1);
    });
  });

  describe('answering', () => {
    it('only the callee can accept; the caller is told, and the call is answered exactly once', async () => {
      const { service, prisma, eventsTo } = setup();
      const { call } = await service.create(OWNER, ALICE);
      await expect(service.accept(BOB, call.id)).rejects.toMatchObject({
        status: 404,
      });
      await expect(service.accept(OWNER, call.id)).rejects.toMatchObject({
        status: 404,
      });
      const res = await service.accept(ALICE, call.id);
      expect(res.call).toMatchObject({
        status: 'answered',
        direction: 'in',
        peer: { id: OWNER },
      });
      expect(prisma.staffCall.rows[0]['answeredAt']).toBeInstanceOf(Date);
      expect(eventsTo(OWNER, 'call.accepted')).toHaveLength(1);
      expect(eventsTo(ALICE, 'call.accepted')).toHaveLength(1);
      await expect(service.accept(ALICE, call.id)).rejects.toMatchObject({
        status: 409,
        response: { code: 'CALL_ALREADY_ANSWERED' },
      });
      await jest.advanceTimersByTimeAsync(CALL_RING_MS + 10);
      expect(prisma.staffCall.rows[0]['status']).toBe('answered');
    });

    it('cannot answer a call that already ended', async () => {
      const { service } = setup();
      const { call } = await service.create(OWNER, ALICE);
      await service.cancel(OWNER, call.id);
      await expect(service.accept(ALICE, call.id)).rejects.toMatchObject({
        status: 410,
      });
    });

    it('refuses to connect when either person has been removed from the team meanwhile', async () => {
      const { service, prisma } = setup();
      const { call } = await service.create(OWNER, ALICE);
      prisma.staffMember.rows.splice(0, 1);
      await expect(service.accept(ALICE, call.id)).rejects.toMatchObject({
        status: 410,
      });
      expect(prisma.staffCall.rows[0]['status']).toBe('failed');
    });

    it('declining ends it for the caller without a missed-call notice for the callee', async () => {
      const { service, eventsTo, notifications } = setup();
      const { call } = await service.create(OWNER, ALICE);
      await service.decline(ALICE, call.id);
      expect(eventsTo(OWNER, 'call.ended')[0].event).toMatchObject({
        status: 'declined',
      });
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('either side can hang up an answered call, once', async () => {
      const { service, prisma, eventsTo } = setup();
      const { call } = await service.create(OWNER, ALICE);
      await service.accept(ALICE, call.id);
      await service.end(ALICE, call.id);
      await service.end(OWNER, call.id);
      expect(prisma.staffCall.rows[0]).toMatchObject({
        status: 'ended',
        endReason: 'hangup',
      });
      expect(eventsTo(OWNER, 'call.ended')).toHaveLength(1);
      await expect(service.end(BOB, call.id)).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('signaling relay', () => {
    it('relays only between the two parties of an answered call', async () => {
      const { service } = setup();
      const { call } = await service.create(OWNER, ALICE);
      expect(await service.relayPeer(OWNER, call.id)).toBeNull();
      await service.accept(ALICE, call.id);
      expect(await service.relayPeer(OWNER, call.id)).toBe(ALICE);
      expect(await service.relayPeer(ALICE, call.id)).toBe(OWNER);
      expect(await service.relayPeer(BOB, call.id)).toBeNull();
      expect(await service.relayPeer(ALICE, 'forged')).toBeNull();
      await service.end(OWNER, call.id);
      expect(await service.relayPeer(ALICE, call.id)).toBeNull();
    });
  });

  describe('connection loss', () => {
    it('ends an answered call when a party stays gone, but forgives a quick reconnect', async () => {
      const { service, prisma, presence, online } = setup();
      service.onModuleInit();
      const { call } = await service.create(OWNER, ALICE);
      await service.accept(ALICE, call.id);
      presence.connection$.next({ userId: ALICE, connected: false });
      await jest.advanceTimersByTimeAsync(5_000);
      presence.connection$.next({ userId: ALICE, connected: true });
      await jest.advanceTimersByTimeAsync(30_000);
      expect(prisma.staffCall.rows[0]['status']).toBe('answered');
      presence.connection$.next({ userId: ALICE, connected: false });
      await jest.advanceTimersByTimeAsync(21_000);
      expect(online.has(ALICE)).toBe(false);
      expect(prisma.staffCall.rows[0]).toMatchObject({
        status: 'ended',
        endReason: 'disconnected',
      });
      service.onModuleDestroy();
    });
  });

  describe('history', () => {
    it('lists calls for both sides, marks unseen missed calls, and clears them when opened', async () => {
      const { service } = setup();
      const { call } = await service.create(OWNER, ALICE);
      await service.markRinging(ALICE, call.id, false);
      await service.cancel(OWNER, call.id);
      const inbox = await service.recent(ALICE);
      expect(inbox.items[0]).toMatchObject({
        direction: 'in',
        status: 'cancelled',
        unseen: true,
        peer: { id: OWNER },
      });
      expect(inbox.missedUnseen).toBe(1);
      expect((await service.directory(ALICE)).missedUnseen).toBe(1);
      await service.markSeen(ALICE);
      expect((await service.recent(ALICE)).missedUnseen).toBe(0);
      expect((await service.recent(OWNER)).items[0]).toMatchObject({
        direction: 'out',
        unseen: false,
      });
    });

    it('reports what is ringing for me so a reopened app can show it', async () => {
      const { service } = setup();
      const { call } = await service.create(OWNER, ALICE);
      expect((await service.active(ALICE)).incoming).toMatchObject({
        id: call.id,
        peer: { id: OWNER },
      });
      expect((await service.active(OWNER)).current).toMatchObject({
        id: call.id,
      });
      expect((await service.active(BOB)).incoming).toBeNull();
    });

    it('the sweeper closes rows no timer will ever close and trims old log entries', async () => {
      const { service, prisma } = setup();
      const old = new Date(Date.now() - 100 * 24 * 3600 * 1000);
      prisma.staffCall.rows.push(
        {
          id: 'a',
          ownerId: OWNER,
          callerId: OWNER,
          calleeId: ALICE,
          status: 'ringing',
          createdAt: new Date(Date.now() - 5 * 60_000),
          endedAt: null,
          answeredAt: null,
        },
        {
          id: 'b',
          ownerId: OWNER,
          callerId: OWNER,
          calleeId: ALICE,
          status: 'ended',
          createdAt: old,
          endedAt: old,
          answeredAt: old,
        },
      );
      await service.sweep();
      expect(
        prisma.staffCall.rows.find((r) => r['id'] === 'a')?.['status'],
      ).toBe('failed');
      expect(
        prisma.staffCall.rows.find((r) => r['id'] === 'b'),
      ).toBeUndefined();
    });
  });

  describe('the platform admin', () => {
    it('has no team list but may call; the directory says so', async () => {
      const { service } = setup();
      await expect(service.directory(ADMIN)).resolves.toMatchObject({
        enabled: true,
        admin: true,
        members: [],
      });
    });

    it('can ring an owner or any staff member of any organisation, shown to them as the Matchena team', async () => {
      const { service, eventsTo, fcm } = setup();
      const toOwner = await service.create(ADMIN, OWNER);
      expect(toOwner.call).toMatchObject({
        status: 'ringing',
        peer: { id: OWNER, role: 'owner' },
      });
      expect(eventsTo(OWNER, 'call.incoming')[0].event['from']).toMatchObject({
        id: ADMIN,
        role: 'admin',
      });
      await service.cancel(ADMIN, toOwner.call.id);

      const toOther = await service.create(ADMIN, OUTSIDER);
      expect(toOther.call.status).toBe('ringing');
      await jest.advanceTimersByTimeAsync(1);
      expect(fcm.sendCall).toHaveBeenCalledWith(
        OUTSIDER,
        expect.objectContaining({ title: 'مكالمة من إدارة ماتشنا' }),
      );
    });

    it("names itself in the callee's language in the push", async () => {
      const { service, fcm } = setup();
      await service.create(ADMIN, BOB);
      await jest.advanceTimersByTimeAsync(1);
      expect(fcm.sendCall).toHaveBeenCalledWith(
        BOB,
        expect.objectContaining({ title: 'Call from Matchena team' }),
      );
    });

    it('is not held back by a mute or do-not-disturb', async () => {
      const { service } = setup();
      await service.setDnd(ALICE, 60);
      expect((await service.create(ADMIN, ALICE)).call.status).toBe('ringing');
    });

    it('still gets "busy" when the person is already on a call', async () => {
      const { service } = setup();
      await service.create(OWNER, ALICE);
      expect((await service.create(ADMIN, ALICE)).call.status).toBe('busy');
    });

    it('cannot call players, suspended people or itself', async () => {
      const { service, prisma } = setup();
      await expect(service.create(ADMIN, 'player-1')).rejects.toMatchObject({
        status: 404,
      });
      await expect(service.create(ADMIN, ADMIN)).rejects.toMatchObject({
        status: 400,
      });
      prisma.user.rows.find((u) => u.id === BOB)!['status'] = 'suspended';
      await expect(service.create(ADMIN, BOB)).rejects.toMatchObject({
        status: 404,
      });
    });

    it('is the only one who can start such a call: nobody in an organisation can call the admin', async () => {
      const { service } = setup();
      await expect(service.create(OWNER, ADMIN)).rejects.toMatchObject({
        status: 404,
      });
      await expect(service.create(ALICE, ADMIN)).rejects.toMatchObject({
        status: 404,
      });
      await expect(service.create('player-1', ADMIN)).rejects.toMatchObject({
        status: 403,
      });
    });

    it('connects when answered, relays only between the two, and ends like any call', async () => {
      const { service, prisma, eventsTo } = setup();
      const { call } = await service.create(ADMIN, ALICE);
      const res = await service.accept(ALICE, call.id);
      expect(res.call).toMatchObject({
        status: 'answered',
        peer: { id: ADMIN, role: 'admin' },
      });
      expect(eventsTo(ADMIN, 'call.accepted')).toHaveLength(1);
      expect(await service.relayPeer(ADMIN, call.id)).toBe(ALICE);
      expect(await service.relayPeer(ALICE, call.id)).toBe(ADMIN);
      expect(await service.relayPeer(BOB, call.id)).toBeNull();
      await service.end(ADMIN, call.id);
      expect(prisma.staffCall.rows[0]).toMatchObject({ status: 'ended' });
    });

    it('does not connect a call from an admin who lost the role meanwhile', async () => {
      const { service, prisma } = setup();
      const { call } = await service.create(ADMIN, ALICE);
      prisma.user.rows.find((u) => u.id === ADMIN)!['roles'] = ['player'];
      await expect(service.accept(ALICE, call.id)).rejects.toMatchObject({
        status: 410,
      });
    });

    it('leaves a "missed call from Matchena team" when nobody answers', async () => {
      const { service, notifications } = setup();
      const { call } = await service.create(ADMIN, ALICE);
      await service.markRinging(ALICE, call.id, false);
      await jest.advanceTimersByTimeAsync(CALL_RING_MS + 10);
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: ALICE,
          titleAr: 'مكالمة فائتة من إدارة ماتشنا',
        }),
      );
    });

    it('shows who was called across organisations, with the right roles and titles', async () => {
      const { service } = setup();
      for (const callee of [ALICE, OWNER, OUTSIDER]) {
        const made = await service.create(ADMIN, callee);
        await service.cancel(ADMIN, made.call.id);
      }
      const { items } = await service.recent(ADMIN);
      const byId = Object.fromEntries(items.map((i) => [i.peer.id, i.peer]));
      expect(byId[ALICE]).toMatchObject({ role: 'staff', title: 'Reception' });
      expect(byId[OWNER]).toMatchObject({ role: 'owner' });
      expect(byId[OUTSIDER]).toMatchObject({ role: 'staff' });
    });

    describe('looking people up', () => {
      it('is for admins only', async () => {
        const { service } = setup();
        await expect(service.adminSearch(OWNER, 'Nasr')).rejects.toMatchObject({
          status: 403,
        });
        await expect(service.adminSearch(ALICE, 'Nasr')).rejects.toMatchObject({
          status: 403,
        });
        await expect(
          service.adminSearch('player-1', 'Nasr'),
        ).rejects.toMatchObject({ status: 403 });
        await expect(service.adminVenue(OWNER, 'v1')).rejects.toMatchObject({
          status: 403,
        });
      });

      it('needs at least two letters', async () => {
        const { service } = setup();
        await expect(service.adminSearch(ADMIN, ' a ')).resolves.toEqual([]);
      });

      it('finding a venue by name lists its owner and staff, owner first, with who they work for', async () => {
        const { service } = setup();
        const found = await service.adminSearch(ADMIN, 'nasr');
        expect(found[0]).toMatchObject({
          id: OWNER,
          role: 'owner',
          ownerName: null,
        });
        expect(found.map((t) => t.id).sort()).toEqual(
          [ALICE, BOB, OWNER].sort(),
        );
        expect(found[0].venues.map((v) => v.nameEn)).toEqual([
          'Nasr Arena',
          'Shorouk Court',
        ]);
        expect(found.find((t) => t.id === ALICE)).toMatchObject({
          role: 'staff',
          ownerName: 'Owner',
        });
        expect(found.some((t) => t.id === OUTSIDER)).toBe(false);
      });

      it('finds a staff member by name or an owner by e-mail, and never players or admins', async () => {
        const { service } = setup();
        expect(
          (await service.adminSearch(ADMIN, 'alice')).map((t) => t.id),
        ).toEqual([ALICE]);
        expect(
          (await service.adminSearch(ADMIN, 'owner@matchena')).map((t) => t.id),
        ).toContain(OWNER);
        expect(await service.adminSearch(ADMIN, 'Pat')).toEqual([]);
        expect(await service.adminSearch(ADMIN, 'Hossam')).toEqual([]);
      });

      it('tells whether they are online, busy or in do-not-disturb', async () => {
        const { service, online } = setup();
        online.add(ALICE);
        await service.setDnd(BOB, 30);
        await service.create(OWNER, ALICE);
        const found = await service.adminSearch(ADMIN, 'nasr');
        expect(found.find((t) => t.id === ALICE)).toMatchObject({
          online: true,
          busy: true,
          dnd: false,
        });
        expect(found.find((t) => t.id === BOB)).toMatchObject({
          online: false,
          busy: false,
          dnd: true,
        });
      });

      it('"call the venue" from a booking: its owner plus the staff who work at that venue', async () => {
        const { service } = setup();
        const nasr = await service.adminVenue(ADMIN, 'v1');
        expect(nasr.venue).toMatchObject({ id: 'v1', nameEn: 'Nasr Arena' });
        expect(nasr.targets.map((t) => t.id).sort()).toEqual(
          [ALICE, BOB, OWNER].sort(),
        );
        const shorouk = await service.adminVenue(ADMIN, 'v2');
        // Alice is limited to venue v1; Bob has no venue list, so he works everywhere.
        expect(shorouk.targets.map((t) => t.id).sort()).toEqual(
          [BOB, OWNER].sort(),
        );
        await expect(service.adminVenue(ADMIN, 'nope')).rejects.toMatchObject({
          status: 404,
        });
      });
    });
  });
});
