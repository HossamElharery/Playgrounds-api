import type { UsageSession,UsageSegment } from '@prisma/client';
export interface BillingSegment {
  startedAtMs: number;
  endedAtMs: number;
  hourlyRateMinor: number;
  currency: string;
}
export interface SessionBillingPolicy {
  version: 1;
  mode: 'exact-time' | 'ceil-started-minute' | 'step-minutes';
  stepMinutes?: number;
  minimumMinutes?: number;
  /**
   * What happens when a timed session passes its planned end. `stop`: the bill stops at the planned end (the session stays open
   * until someone collects or extends). `continue`: the clock keeps counting (the original behavior). `auto-end`: the session is
   * closed at its planned end. Sessions without this field behave as `continue`. Booking sessions are never capped.
   */
  overrun?: 'stop' | 'continue' | 'auto-end';
  /** Time the session spent past its planned end before it was extended; never billed (`stop` only). */
  pausedMs?: number;
}

export const OVERRUN_MODES = ['stop', 'continue', 'auto-end'] as const;
export const DEFAULT_OVERRUN = 'stop' as const;

/** Does the planned end cap what this session is billed? */
export function capsAtPlannedEnd(s: { policy: unknown; expectedEnd: Date | null; bookingId?: string | null }): boolean {
  const mode = (s.policy as SessionBillingPolicy | null)?.overrun;
  return !!s.expectedEnd && !s.bookingId && (mode === 'stop' || mode === 'auto-end');
}
const HOUR_MS = 3_600_000n;
const MAX_AMOUNT = 2_147_483_647n;
function integer(value: number, min = 0): void {
  if (!Number.isSafeInteger(value) || value < min) throw new RangeError('Invalid billing integer');
}
export function calculateSessionCharge(segments: readonly BillingSegment[], policy: SessionBillingPolicy) {
  if (policy.version !== 1 || !['exact-time', 'ceil-started-minute', 'step-minutes'].includes(policy.mode)) throw new RangeError('Invalid billing policy');
  integer(policy.minimumMinutes ?? 0);
  if ((policy.minimumMinutes ?? 0) > 720) throw new RangeError('Minimum exceeds limit');
  if (policy.mode === 'step-minutes') {
    integer(policy.stepMinutes!, 1);
    if (policy.stepMinutes! > 720) throw new RangeError('Step exceeds limit');
  }
  if (!segments.length) throw new RangeError('At least one segment is required');
  if (segments.length > 1000) throw new RangeError('Too many segments');
  const currency = segments[0].currency;
  if (!/^[A-Z]{3}$/.test(currency)) throw new RangeError('Invalid currency');
  let weighted = 0n;
  let elapsedMs = 0n;
  segments.forEach((s, index) => {
    integer(s.startedAtMs); integer(s.endedAtMs); integer(s.hourlyRateMinor);
    if (BigInt(s.hourlyRateMinor) > MAX_AMOUNT || s.currency !== currency || s.endedAtMs < s.startedAtMs ||
        (index > 0 && segments[index - 1].endedAtMs !== s.startedAtMs)) throw new RangeError('Invalid or discontinuous segment');
    const duration = BigInt(s.endedAtMs) - BigInt(s.startedAtMs);
    elapsedMs += duration;
    weighted += duration * BigInt(s.hourlyRateMinor);
  });
  let billableMs = elapsedMs;
  const step = policy.mode === 'exact-time' ? 1n : BigInt(policy.mode === 'ceil-started-minute' ? 1 : policy.stepMinutes!) * 60_000n;
  billableMs = ((billableMs + step - 1n) / step) * step;
  const minimum = BigInt(policy.minimumMinutes ?? 0) * 60_000n;
  if (billableMs < minimum) billableMs = minimum;
  weighted += (billableMs - elapsedMs) * BigInt(segments[segments.length - 1].hourlyRateMinor);
  const amount = (weighted + HOUR_MS / 2n) / HOUR_MS;
  if (amount > MAX_AMOUNT || elapsedMs > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Charge exceeds storage limit');
  return { amountMinor: Number(amount), currency, elapsedMs: Number(elapsedMs), billableMs: Number(billableMs), policyVersion: 1 as const };
}

export function allocatePayment(amountMinor: number, outstandingMinor: readonly number[]): number[] {
  integer(amountMinor);
  outstandingMinor.forEach(v => integer(v));
  const total = outstandingMinor.reduce((n, v) => n + BigInt(v), 0n);
  if (BigInt(amountMinor) > total) throw new RangeError('Overpayment');
  if (!total) return outstandingMinor.map(() => 0);
  const amount = BigInt(amountMinor);
  const result = outstandingMinor.map(v => Number(amount * BigInt(v) / total));
  let remaining = amountMinor - result.reduce((n, v) => n + v, 0);
  const ranked = outstandingMinor.map((v, index) => ({ index, remainder: amount * BigInt(v) % total }))
    .sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const line of ranked) { if (!remaining) break; result[line.index]++; remaining--; }
  return result;
}

export function calculateUsageCharge(s:UsageSession & {segments:UsageSegment[]},now:Date){
    if(s.state==='voided') return 0;
    const first=s.segments[0]; const snap=first?.rateSnapshot as {bookingTotalMinor?:number|null;coveredUntil?:string|null};
    if(snap?.coveredUntil) {
      const covered=new Date(snap.coveredUntil).getTime();
      if((s.endedAt??now).getTime()<=covered)return 0;
      const segments=s.segments.map(x=>({startedAtMs:Math.max(x.startedAt.getTime(),covered),endedAtMs:Math.max((x.endedAt??now).getTime(),covered),hourlyRateMinor:x.hourlyRateMinor,currency:x.currency}));
      return calculateSessionCharge(segments,{...(s.policy as unknown as SessionBillingPolicy),minimumMinutes:0}).amountMinor;
    }
    const policy=s.policy as unknown as SessionBillingPolicy;
    const raw=s.segments.map(x=>({startedAtMs:x.startedAt.getTime(),endedAtMs:(x.endedAt??now).getTime(),hourlyRateMinor:x.hourlyRateMinor,currency:x.currency}));
    if(!capsAtPlannedEnd(s))return calculateSessionCharge(raw,policy).amountMinor;
    // The bill stops at the planned end; time spent waiting for an extension is not billed either.
    const cap=s.expectedEnd!.getTime();
    const clipped=raw.map(x=>({...x,startedAtMs:Math.min(x.startedAtMs,cap),endedAtMs:Math.min(x.endedAtMs,cap)}));
    let pause=Math.max(0,Math.floor(policy.pausedMs??0));
    for(let i=clipped.length-1;i>=0&&pause>0;i--){const room=clipped[i].endedAtMs-clipped[i].startedAtMs;const take=Math.min(room,pause);clipped[i].endedAtMs-=take;pause-=take;for(let j=i+1;j<clipped.length;j++){clipped[j].startedAtMs-=take;clipped[j].endedAtMs-=take;}}
    return calculateSessionCharge(clipped,policy).amountMinor;
}
