export const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.]{3,29}$/;

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidUsername(raw: string): boolean {
  return USERNAME_PATTERN.test(raw.trim());
}
