/**
 * Everything is stored as UTC epoch seconds. Timezone only ever re-enters at
 * render time, via the IANA zone the schedule was captured in -- which is what
 * keeps DST boundaries correct without any offset arithmetic of our own.
 */

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function minutes(n: number): number {
  return n * 60;
}

/**
 * Render a UTC epoch in the creator's local zone for post copy.
 * Falls back to UTC if the zone string is not one the runtime recognises.
 */
export function formatLocalTime(epochSec: number, timeZone: string): string {
  const date = new Date(epochSec * 1000);
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(date);
  }
}

export function formatLocalDateTime(epochSec: number, timeZone: string): string {
  const date = new Date(epochSec * 1000);
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** UTC month key, used to bucket the X spend guard. */
export function monthKey(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Start of the UTC month containing `epochSec`, as epoch seconds. */
export function monthStart(epochSec: number): number {
  const d = new Date(epochSec * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
}
