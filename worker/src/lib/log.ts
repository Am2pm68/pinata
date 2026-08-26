type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured single-line logs. Never log captions, tokens or asset URLs at
 * anything above debug -- the audit trail in D1 is the record of what was sent.
 */
export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, event, ts: new Date().toISOString(), ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
