import { describe, expect, it } from "vitest";
import { createCoalescer } from "../src/lib/coalesce";

function fakeClock() {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  return {
    clock: {
      now: () => now,
      setTimeout: (fn: () => void, ms: number) => {
        const id = ++seq;
        timers.push({ at: now + ms, fn, id });
        return id;
      },
      clearTimeout: (id: unknown) => {
        const i = timers.findIndex((t) => t.id === id);
        if (i >= 0) timers.splice(i, 1);
      },
    },
    advance(ms: number) {
      now += ms;
      for (const t of timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
  };
}

describe("createCoalescer", () => {
  it("sends at most one update per interval per key, keeping the newest", () => {
    const f = fakeClock();
    const sent: [string, number, number][] = [];
    const c = createCoalescer<number>(1000, (k, v) => sent.push([k, v, f.clock.now()]), f.clock);
    c.push("AAA", 1); // immediate
    c.push("AAA", 2); // held
    c.push("AAA", 3); // replaces 2
    c.push("BBB", 9); // other key: immediate
    f.advance(999);
    expect(sent).toEqual([
      ["AAA", 1, 0],
      ["BBB", 9, 0],
    ]);
    f.advance(1);
    expect(sent.at(-1)).toEqual(["AAA", 3, 1000]);
    f.advance(1500);
    c.push("AAA", 4); // an interval has passed since the last send: immediate
    expect(sent.at(-1)).toEqual(["AAA", 4, 2500]);
  });

  it("drops held updates when closed", () => {
    const f = fakeClock();
    const sent: number[] = [];
    const c = createCoalescer<number>(1000, (_k, v) => sent.push(v), f.clock);
    c.push("AAA", 1);
    c.push("AAA", 2);
    c.close();
    f.advance(5000);
    expect(sent).toEqual([1]);
  });
});
