/**
 * The owner assistant's vocabulary.
 *
 * Everything the owner can say collapses into one of these intents, and
 * everything the assistant is willing to *do* collapses into one of the
 * actions below. Nothing else is executable — the model proposes, this
 * union constrains, and each action is re-validated server-side before it
 * runs (see owner-assistant.service.ts).
 */
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
  | 'agenda' // "what is booked?" — the day's bookings
  | 'attention' // "anything I should know?" — debts, arrivals, tomorrow
  | 'move' // change an existing booking's time / court / length / price
  | 'help'
  | 'unknown';

/** Bilingual text — owners work in Arabic, the dashboard also ships English. */
export interface Bi {
  ar: string;
  en: string;
}

/**
 * What the model read out of the sentence. Amounts are in MAJOR units here
 * (the owner says "٢٠٠ جنيه", not 20000 piastres) and are converted once, in
 * the service, so the conversion cannot happen twice by accident.
 */
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
  /** Total price the owner stated for the booking, major units. */
  totalAmount: number | null;
  /** Money the owner says they already took, major units. */
  paidAmount: number | null;
  /** Money the owner says is still owed, major units — the cross-check for the two above. */
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
  /**
   * For `move`: where the booking should go. `date`/`fromMins`/`courtIds` above
   * identify the booking as it is today; these say what it should become.
   */
  newDate: string | null;
  newFromMins: number | null;
  newCourtId: string | null;
  /** A short question in the owner's language when something is missing or unclear. */
  question: string;
  /** Which model read the sentence, how long it took and what it cost. Never holds the sentence itself. */
  meta?: { model: string; ms: number; costUsd: number };
}

/** A booking the assistant found and may act on — echoed back so the confirm card can name it. */
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

/**
 * Money actions run on the server (they touch the ledger). Schedule actions
 * are handed back to the day board instead: it already owns block splitting,
 * the optimistic overlay and the undo token, and re-deriving that here would
 * be a second source of truth for the same rows.
 */
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
      /** The owner confirmed reopening a window they had closed; the server carves the block out. */
      overrideBlocks?: boolean;
    }
  | {
      kind: 'record_payment';
      requestKey?: string;
      bookingId: string;
      amount: number;
      method?: string;
    }
  | { kind: 'cancel_booking'; bookingId: string; reason?: string }
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

/** A schedule change the day board executes with its existing block/undo machinery. */
export interface AssistantScheduleIntent {
  mode: 'block' | 'unblock';
  courtIds: string[];
  allCourts: boolean;
  date: string;
  fromMins: number | null;
  toMins: number | null;
  reason: string;
}

/**
 * Something that does not add up. `blocking: true` means the assistant refused
 * to write anything — the owner's own numbers contradict each other or the
 * venue's records, and guessing which one is right is how a cash drawer goes
 * wrong.
 */
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
  /** false when no AI provider is configured — the client falls back to its local parser. */
  available: boolean;
  intent: AssistantIntentKind;
  confidence: number;
  /** What the assistant says back. Always populated, in both languages. */
  reply: Bi;
  /** Shown on the confirm card above the buttons; empty for a pure answer. */
  summary: Bi | null;
  actions: AssistantAction[];
  schedule: AssistantScheduleIntent | null;
  /** Populated for questions the day board answers off its own grid ("what is free?"). */
  query: AssistantQuery | null;
  issues: AssistantIssue[];
  /** Bookings the reply refers to, so the client can deep-link to them. */
  bookings: AssistantBookingRef[];
  needsConfirm: boolean;
  /**
   * What the assistant understood so far when it had to ask a question. The
   * client hands it back with the owner's next message so an answer like
   * "PS5 Room 1" completes the earlier request instead of starting a new one.
   */
  draft?: AssistantReading | null;
}

export function bi(ar: string, en: string): Bi {
  return { ar, en };
}
