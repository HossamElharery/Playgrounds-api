export interface Money {
  amount: number; // minor units (e.g. piasters)
  currency: string;
}

export function toMoney(amountMinorUnits: number, currency = 'EGP'): Money {
  return { amount: amountMinorUnits, currency };
}

export function egpToMinorUnits(egp: number): number {
  return Math.round(egp * 100);
}
