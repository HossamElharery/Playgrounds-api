let draining = false;

export function beginShutdownDrain(): void {
  draining = true;
}

export function isShutdownDraining(): boolean {
  return draining;
}

/** Test-only reset; production startup always begins in the accepting state. */
export function resetShutdownDrainForTests(): void {
  draining = false;
}
