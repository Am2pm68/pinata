import { vi } from 'vitest';

/**
 * Pin wall-clock time.
 *
 * Rows are stamped with `Date.now()` inside the repository while the control
 * loop is driven by an explicit `now`. Tests move both together so that
 * age-based logic -- the stale-intent sweep, the dedupe window, the monthly
 * spend bucket -- sees a coherent timeline.
 */
export function setClock(epochSeconds: number): void {
  vi.setSystemTime(epochSeconds * 1000);
}

export function useFixedClock(epochSeconds: number): void {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  setClock(epochSeconds);
}

export function restoreClock(): void {
  vi.useRealTimers();
}
