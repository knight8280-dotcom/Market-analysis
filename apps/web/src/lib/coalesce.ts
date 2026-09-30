/**
 * Per-key rate limiting that keeps the latest value: the first update for a key goes out at
 * once; further updates within `intervalMs` are held and the newest is sent when the interval
 * ends. Used to cap live quotes at one update per second per symbol.
 */
export function createCoalescer<T>(
  intervalMs: number,
  send: (key: string, value: T) => void,
  clock: {
    now: () => number;
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (t: unknown) => void;
  } = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  },
) {
  const lastSent = new Map<string, number>();
  const pending = new Map<string, { value: T; timer: unknown }>();

  const flush = (key: string, value: T) => {
    lastSent.set(key, clock.now());
    send(key, value);
  };

  return {
    push(key: string, value: T) {
      const now = clock.now();
      const last = lastSent.get(key);
      const held = pending.get(key);
      if (held) {
        held.value = value;
        return;
      }
      if (last === undefined || now - last >= intervalMs) {
        flush(key, value);
        return;
      }
      const entry = {
        value,
        timer: clock.setTimeout(
          () => {
            pending.delete(key);
            flush(key, entry.value);
          },
          intervalMs - (now - last),
        ),
      };
      pending.set(key, entry);
    },
    close() {
      for (const { timer } of pending.values()) clock.clearTimeout(timer);
      pending.clear();
    },
  };
}
