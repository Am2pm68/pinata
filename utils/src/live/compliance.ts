const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidUsername(username: string): boolean {
  return USERNAME_PATTERN.test(username);
}

// Per the documented StripCash aggregator cutover plan: refresh every 30s,
// treat anything older than ~40s as no longer live.
export const REFRESH_INTERVAL_MS = 30_000;
export const LIVENESS_CUTOFF_MS = 40_000;

export function isFresh(fetchedAtMs: number, nowMs: number): boolean {
  return nowMs - fetchedAtMs <= LIVENESS_CUTOFF_MS;
}

export function parseBannedCountries(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((code) => code.trim().toUpperCase())
      .filter(Boolean)
  );
}

export function isCountryAllowed(countryCode: string | undefined, banned: Set<string>): boolean {
  if (!countryCode || banned.size === 0) return true;
  return !banned.has(countryCode.toUpperCase());
}
