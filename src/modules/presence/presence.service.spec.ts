import { PresenceService, PRESENCE_ONLINE_WINDOW_MS } from './presence.service';

describe('PresenceService', () => {
  let presence: PresenceService;

  beforeEach(() => {
    presence = new PresenceService();
  });

  it('is offline with no socket and no recent lastSeenAt', () => {
    expect(presence.stateFor('u1')).toBe('offline');
    expect(presence.stateFor('u1', new Date(Date.now() - PRESENCE_ONLINE_WINDOW_MS - 1))).toBe(
      'offline',
    );
  });

  it('is online while a socket is connected', () => {
    presence.markConnected('u1', 's1');
    expect(presence.stateFor('u1')).toBe('online');
    presence.markDisconnected('u1', 's1');
    expect(presence.stateFor('u1')).toBe('offline');
  });

  it('treats a fresh lastSeenAt as online without a socket', () => {
    expect(presence.stateFor('u1', new Date())).toBe('online');
    expect(presence.stateFor('u1', new Date().toISOString())).toBe('online');
  });

  it('prefers in_squad over online', () => {
    presence.markConnected('u1', 's1');
    presence.setInSquad('u1', true);
    expect(presence.stateFor('u1', new Date())).toBe('in_squad');
  });
});
