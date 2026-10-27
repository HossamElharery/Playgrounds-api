export type AssistantIntentKind =
  | 'block' // close slots
  | 'unblock' // reopen slots
  | 'book' // record a real booking (with its money)
  | 'pay' // collect money on an existing booking
  | 'cancel' // cancel a manual booking
  | 'free' // "what is open?"
  | 'money' // "how much did I make?"
  | 'debts' // "who still owes me?"
  | 'expense' // record a cost
  | 'agenda'
  | 'attention'
  | 'next_booking' // nearest upcoming booking
  | 'late_arrivals' // confirmed bookings that have not checked in
  | 'booking_details' // details for one named/timed booking
  | 'cash_drawer' // cash received and expected today
  | 'occupancy' // occupancy and quiet-hour insight
  | 'move' // change an existing booking's time / court / length / price
  | 'help'
  | 'unknown';

export interface Bi {
  ar: string;
  en: string;
}

export interface AssistantReading {
  intent: AssistantIntentKind;
  courtIds: string[];
  allCourts: boolean;
  date: string;
  fromMins: number | null;
  toMins: number | null;
  durationMinutes: number | null;
  customerName: string;
  customerPhone: string;
  totalAmount: number | null;
  paidAmount: number | null;
  remainingAmount: number | null;
  paymentMethod: 'cash' | 'instapay' | 'wallet' | 'card' | 'other' | null;
  sourceKey: 'walk_in' | 'phone' | 'whatsapp' | 'other_platform' | null;
  expenseCategory: string | null;
  rangeKey:
    | 'today'
    | 'yesterday'
    | 'this_week'
    | 'last_7_days'
    | 'this_month'
    | 'last_month'
    | null;
  reason: string;
  confidence: number;
  newDate: string | null;
  newFromMins: number | null;
  newCourtId: string | null;
  question: string;
  meta?: { model: string; ms: number; costUsd: number };
}

export interface AssistantBookingRef {
  id: string;
  code: string;
  customerName: string | null;
  courtName: string;
  startsAt: string;
  endsAt: string;
  totalAmount: number;
  paidAmount: number;
  outstanding: number;
  currency: string;
}

export type AssistantAction =
  | {
      kind: 'create_booking';
      courtId: string;
      startsAt: string;
      durationMinutes: number;
      priceAmount: number;
      paymentStatus: 'paid' | 'unpaid' | 'partial';
      paidAmount?: number;
      paymentMethod?: 'cash' | 'instapay' | 'wallet' | 'card' | 'other';
      customerName?: string;
      customerPhone?: string;
      sourceKey?: 'walk_in' | 'phone' | 'whatsapp' | 'other_platform';
      notes?: string;
      overrideBlocks?: boolean;
    }
  | {
      kind: 'record_payment';
      requestKey?: string;
      bookingId: string;
      amount: number;
      method?: string;
    }
  | { kind: 'cancel_booking'; bookingId: string; reason?: string; refundAmount?: number }
  | {
      kind: 'update_booking';
      bookingId: string;
      courtId?: string;
      startsAt?: string;
      durationMinutes?: number;
      priceAmount?: number;
    }
  | {
      kind: 'add_expense';
      venueId: string;
      category: string;
      amount: number;
      incurredOn: string;
      note?: string;
    };

export interface AssistantScheduleIntent {
  mode: 'block' | 'unblock';
  courtIds: string[];
  allCourts: boolean;
  date: string;
  fromMins: number | null;
  toMins: number | null;
  reason: string;
}

export interface AssistantIssue {
  code:
    | 'MATH_MISMATCH'
    | 'PRICE_BELOW_TARIFF'
    | 'PRICE_ABOVE_TARIFF'
    | 'PAID_OVER_TOTAL'
    | 'OVERPAYMENT'
    | 'NO_PRICE'
    | 'SLOT_TAKEN'
    | 'AMBIGUOUS_BOOKING'
    | 'NOT_FOUND'
    | 'PLATFORM_LOCKED'
    | 'PAST_SLOT'
    | 'BLOCK_OVERRIDE'
    | 'DUPLICATE_CUSTOMER'
    | 'LONG_BOOKING'
    | 'HAS_BOOKINGS'
    | 'NO_PERMISSION';
  blocking: boolean;
  message: Bi;
}

export interface AssistantQuery {
  date: string;
  courtIds: string[];
  allCourts: boolean;
  fromMins: number | null;
  toMins: number | null;
}

export interface AssistantPlan {
  available: boolean;
  intent: AssistantIntentKind;
  confidence: number;
  reply: Bi;
  summary: Bi | null;
  actions: AssistantAction[];
  schedule: AssistantScheduleIntent | null;
  query: AssistantQuery | null;
  issues: AssistantIssue[];
  bookings: AssistantBookingRef[];
  needsConfirm: boolean;
  draft?: AssistantReading | null;
}

export function bi(ar: string, en: string): Bi {
  return { ar, en };
}
