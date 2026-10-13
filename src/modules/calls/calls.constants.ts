/** How long a call rings before it becomes a missed call. */
export const CALL_RING_MS = 45_000;
/** A phone that has not confirmed it is ringing within this long also gets a push. */
export const CALL_PUSH_DELAY_MS = 2_000;
/** A party whose last socket is gone this long ends the call (a network flap is forgiven). */
export const CALL_DISCONNECT_GRACE_MS = 20_000;
/** The longest a call is ever assumed to last; older "answered" rows are closed by the sweeper. */
export const CALL_MAX_DURATION_MS = 8 * 60 * 60 * 1000;
/** Call log kept this long (metadata only — there is never any audio). */
export const CALL_RETENTION_DAYS = 90;
/** Nobody can be muted (or do-not-disturb) for longer than this, so the owner is never shut out for good. */
export const MAX_MUTE_MINUTES = 480;
export const CALL_SWEEP_EVERY_MS = 60_000;
