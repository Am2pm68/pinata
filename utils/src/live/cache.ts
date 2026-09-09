export interface TtlCache<T> {
  read(nowMs: number): { value: T; fetchedAtMs: number } | null;
  write(value: T, nowMs: number): void;
}

export function createTtlCache<T>(ttlMs: number): TtlCache<T> {
  let value: T | null = null;
  let fetchedAtMs = 0;

  return {
    read(nowMs: number) {
      if (value === null || nowMs - fetchedAtMs > ttlMs) return null;
      return { value, fetchedAtMs };
    },
    write(next: T, nowMs: number) {
      value = next;
      fetchedAtMs = nowMs;
    },
  };
}
