import { bi, type AssistantIssue, type Bi } from './assistant.types';

/** Minor units in, "٢٠٠ ج.م" / "200 EGP" out — one place, so no screen invents its own rounding. */
export function fmtMoney(minor: number, currency: string): Bi {
  const major = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
  }).format(minor / 100);
  return bi(
    `${major} ${currency === 'EGP' ? 'ج.م' : currency}`,
    `${major} ${currency}`,
  );
}

export function toMinor(major: number): number {
  return Math.round(major * 100);
}

/** What the owner said out loud, in minor units. `null` means they did not say it. */
export interface StatedMoney {
  total: number | null;
  paid: number | null;
  remaining: number | null;
}

export interface SettledMoney {
  total: number;
  paid: number;
  outstanding: number;
  status: 'paid' | 'unpaid' | 'partial';
}

export interface MoneyVerdict {
  /** null when the numbers cannot be trusted — see `issues` for why. */
  money: SettledMoney | null;
  issues: AssistantIssue[];
}

/**
 * Reconciles the three numbers an owner throws around — total, paid, still
 * owed — against each other and against the venue's own tariff.
 *
 * The refusals are the point of this function. "خدت منه ٢٠٠ وباقي ٤٠٠" on a
 * court whose tariff says 1200 is not a booking to file quietly at 600; it is
 * a cash conversation the owner needs to have before the customer leaves. So:
 *
 *  - three numbers that contradict each other  → refuse, quote the gap
 *  - paid more than the whole booking          → refuse, quote both
 *  - a price that differs from the tariff      → allow (discounts are real),
 *                                                but never silently
 *  - no price anywhere                         → refuse, ask
 */
export function reconcileBookingMoney(
  stated: StatedMoney,
  tariffMinor: number | null,
  currency: string,
): MoneyVerdict {
  const issues: AssistantIssue[] = [];
  const money = (minor: number) => fmtMoney(minor, currency);

  let total = stated.total;
  if (total === null && stated.paid !== null && stated.remaining !== null) {
    total = stated.paid + stated.remaining;
  }
  if (total === null) total = tariffMinor;
  if (total === null) {
    issues.push({
      code: 'NO_PRICE',
      blocking: true,
      message: bi(
        'مفيش تسعيرة للميعاد ده ومقولتليش السعر — قولّي الحجز بكام.',
        'There is no tariff for that time and you did not say the price — tell me what it costs.',
      ),
    });
    return { money: null, issues };
  }

  // Three numbers that disagree: only the owner knows which one is wrong, so
  // nothing is written until they say.
  if (
    stated.total !== null &&
    stated.paid !== null &&
    stated.remaining !== null
  ) {
    const sum = stated.paid + stated.remaining;
    if (sum !== stated.total) {
      issues.push({
        code: 'MATH_MISMATCH',
        blocking: true,
        message: bi(
          `الحساب مش مظبوط: ${money(stated.paid).ar} + ${money(stated.remaining).ar} = ${money(sum).ar}، ` +
            `مش ${money(stated.total).ar}. فيه فرق ${money(Math.abs(sum - stated.total)).ar}. قولّي الصح إيه وأنا أسجّله.`,
          `Those numbers do not add up: ${money(stated.paid).en} + ${money(stated.remaining).en} = ${money(sum).en}, ` +
            `not ${money(stated.total).en} — a ${money(Math.abs(sum - stated.total)).en} gap. Tell me which is right and I will record it.`,
        ),
      });
      return { money: null, issues };
    }
  }

  let paid = stated.paid;
  if (paid === null && stated.remaining !== null)
    paid = Math.max(0, total - stated.remaining);
  // "احجز لمحمد بـ 400" with no payment talk: the counter took the money.
  if (paid === null) paid = total;
  if (paid > total) {
    issues.push({
      code: 'PAID_OVER_TOTAL',
      blocking: true,
      message: bi(
        `قلت إنك خدت ${money(paid).ar} والحجز كله ${money(total).ar} — المدفوع أكبر من السعر. راجع معايا.`,
        `You said you took ${money(paid).en} on a ${money(total).en} booking — that is more than the price. Let us check.`,
      ),
    });
    return { money: null, issues };
  }

  // A stated price may differ from the tariff (discounts are real), but the
  // gap goes on the confirm card where the owner has to look at it.
  if (
    stated.total !== null &&
    tariffMinor !== null &&
    stated.total !== tariffMinor
  ) {
    const gap = money(Math.abs(stated.total - tariffMinor));
    const below = stated.total < tariffMinor;
    issues.push({
      code: below ? 'PRICE_BELOW_TARIFF' : 'PRICE_ABOVE_TARIFF',
      blocking: false,
      message: bi(
        below
          ? `تنبيه: تسعيرة الميعاد ده ${money(tariffMinor).ar} وانت قلت ${money(stated.total).ar} — أقل بـ ${gap.ar}. هسجّلها بسعرك لو ده خصم مقصود.`
          : `تنبيه: تسعيرة الميعاد ده ${money(tariffMinor).ar} وانت قلت ${money(stated.total).ar} — أعلى بـ ${gap.ar}.`,
        below
          ? `Heads up: the tariff for that slot is ${money(tariffMinor).en}, you said ${money(stated.total).en} — ${gap.en} less. I will use your price if the discount is intended.`
          : `Heads up: the tariff for that slot is ${money(tariffMinor).en}, you said ${money(stated.total).en} — ${gap.en} more.`,
      ),
    });
  }

  const outstanding = total - paid;
  return {
    money: {
      total,
      paid,
      outstanding,
      status: outstanding <= 0 ? 'paid' : paid <= 0 ? 'unpaid' : 'partial',
    },
    issues,
  };
}
