import { expect } from "./assert.js";
import type { ReactiveFramework } from "./framework.js";
import { SkipTest, hasComputedThrows } from "./framework.js";

/**
 * Exception Recovery
 *
 * Tests that errors discovered while validating old dependencies do not
 * poison dependency branches that are no longer used. Errors on the current
 * execution path must still propagate, and effects must remain usable after
 * failed or runaway executions.
 *
 * Legend:
 *   S        signal (source)
 *   C        computed
 *   E / eff  effect
 *   ─→       dependency edge (downstream reads upstream)
 *   ?─→      conditional dependency edge
 *   ⚡       node that may throw
 */
export const section = "Exception Recovery";
export const cases: Record<string, (fw: ReactiveFramework) => any> = {
  /**
   *  S(useBad) ?─→ C(parent)
   *  S(source) ─→ C(bad ⚡) ?─→ C(parent)
   *  S(safe)   ?────────────→ C(parent)
   *
   * parent initially uses bad. source makes bad throw, then useBad switches
   * parent to safe before parent is read again. Validation of the old bad
   * dependency must not prevent parent from taking its new safe branch.
   */
  "#248 obsolete throwing dependency is dropped after branch switch"(
    fw: ReactiveFramework
  ) {
    if (!hasComputedThrows(fw)) throw new SkipTest("no computedThrows");

    const useBad = fw.signal(true);
    const source = fw.signal(0);
    const safe = fw.signal(10);

    const bad = fw.computed(() => {
      const value = source.read();
      if (value === 1) throw new Error("obsolete error");
      return value;
    });

    const parent = fw.computed(() =>
      useBad.read() ? bad.read() : safe.read()
    );

    expect(parent.read()).toBe(0);

    try {
      source.write(1);
    } catch {}
    useBad.write(false);

    expect(parent.read()).toBe(10);

    safe.write(20);
    expect(parent.read()).toBe(20);
  },

  /**
   *  S(useBad) ?─→ C(parent)
   *  S(a) → C(first ⚡)  ?─→ C(parent)
   *  S(b) → C(second ⚡) ?─→ C(parent)
   *  S(safe) ?─────────────→ C(parent)
   *
   * Both old computed dependencies throw while parent validates its previous
   * dependency set. Validation must continue and parent must still switch to
   * the safe branch.
   */
  "#249 multiple obsolete throwing dependencies do not block branch switch"(
    fw: ReactiveFramework
  ) {
    if (!hasComputedThrows(fw)) throw new SkipTest("no computedThrows");

    const useBad = fw.signal(true);
    const a = fw.signal(0);
    const b = fw.signal(0);
    const safe = fw.signal(5);

    const first = fw.computed(() => {
      const value = a.read();
      if (value === 1) throw new Error("first error");
      return value;
    });

    const second = fw.computed(() => {
      const value = b.read();
      if (value === 1) throw new Error("second error");
      return value;
    });

    const parent = fw.computed(() =>
      useBad.read() ? first.read() + second.read() : safe.read()
    );

    expect(parent.read()).toBe(0);

    try {
      a.write(1);
    } catch {}
    try {
      b.write(1);
    } catch {}
    useBad.write(false);

    expect(parent.read()).toBe(5);
  },

  /**
   *  S(source) → C(child ⚡) → C(parent)
   *
   * A dependency error that is still present on the current execution path
   * must propagate. After source recovers, both computeds must recover too.
   */
  "#250 active throwing dependency still propagates and recovers"(
    fw: ReactiveFramework
  ) {
    if (!hasComputedThrows(fw)) throw new SkipTest("no computedThrows");

    const source = fw.signal(0);
    const child = fw.computed(() => {
      const value = source.read();
      if (value === 1) throw new Error("active error");
      return value;
    });
    const parent = fw.computed(() => child.read() * 2);

    expect(parent.read()).toBe(0);

    try {
      source.write(1);
    } catch {}
    expect(() => parent.read()).toThrow("active error");

    source.write(2);
    expect(parent.read()).toBe(4);
  },

  /**
   *  S(source) → C(child ⚡) → C(parent catches)
   *
   * parent handles the child error as data. It must remain subscribed to the
   * failed child and re-evaluate when child can recover.
   */
  "#251 parent computed can catch child error and recover"(
    fw: ReactiveFramework
  ) {
    if (!hasComputedThrows(fw)) throw new SkipTest("no computedThrows");

    const source = fw.signal(0);
    const child = fw.computed(() => {
      const value = source.read();
      if (value === 1) throw new Error("child error");
      return value;
    });
    const parent = fw.computed(() => {
      try {
        return child.read();
      } catch {
        return -1;
      }
    });

    expect(parent.read()).toBe(0);

    try {
      source.write(1);
    } catch {}
    expect(parent.read()).toBe(-1);

    source.write(2);
    expect(parent.read()).toBe(2);
  },

  /**
   *  S(source) → C(value ⚡, otherwise always "same") → E
   *
   * Recovery may produce the same value as before the error. The effect still
   * needs another run because observable behavior changed from throwing back
   * to returning.
   */
  "#252 same-value recovery after error reaches watching effect"(
    fw: ReactiveFramework
  ) {
    if (!hasComputedThrows(fw)) throw new SkipTest("no computedThrows");

    const source = fw.signal(0);
    const value = fw.computed(() => {
      if (source.read() === 1) throw new Error("temporary error");
      return "same";
    });

    const seen: string[] = [];
    fw.effect(() => {
      try {
        seen.push(value.read());
      } catch {
        seen.push("error");
      }
    });

    expect(seen).toEqual(["same"]);

    try {
      source.write(1);
    } catch {}
    expect(seen).toContain("error");

    try {
      source.write(2);
    } catch {}
    expect(seen[seen.length - 1]).toBe("same");
  },

  /**
   *  S(trigger) → C(value ⚡ before reading late) → E
   *  S(late)    ?─→ C(value)
   *
   * A failed evaluation retains dependencies read before the throw. Changing
   * trigger must retry the computed; after recovery, the newly reached late
   * dependency must also be tracked.
   */
  "#253 partial dependencies survive throw and update after recovery"(
    fw: ReactiveFramework
  ) {
    if (!hasComputedThrows(fw)) throw new SkipTest("no computedThrows");

    const trigger = fw.signal(0);
    const late = fw.signal(10);
    const value = fw.computed(() => {
      const current = trigger.read();
      if (current === 1) throw new Error("partial error");
      return current + late.read();
    });

    const seen: Array<number | "error"> = [];
    fw.effect(() => {
      try {
        seen.push(value.read());
      } catch {
        seen.push("error");
      }
    });

    expect(seen).toEqual([10]);

    try {
      trigger.write(1);
    } catch {}
    expect(seen).toContain("error");

    try {
      trigger.write(2);
    } catch {}
    expect(seen[seen.length - 1]).toBe(12);

    late.write(20);
    expect(seen[seen.length - 1]).toBe(22);
  },

  /**
   *  S(enabled) → E(loop ⚡) → S(value) ⟳
   *                       S(value) → E(observer)
   *
   * The effect creates a runaway write-read loop. It disables itself and
   * throws after a bounded number of runs. Pending scheduled state must be
   * cleared: later value writes must not restart the loop, while unrelated
   * reactive work must still execute.
   */
  "#254 graph recovers after bounded runaway effect throws"(
    fw: ReactiveFramework
  ) {
    const enabled = fw.signal(false);
    const value = fw.signal(0);
    const other = fw.signal(0);

    let iterations = 0;
    const disposeLoop = fw.effect(() => {
      if (!enabled.read()) return;

      const current = value.read();
      iterations++;

      if (iterations >= 50) {
        enabled.write(false);
        throw new Error("stop runaway effect");
      }

      value.write(current + 1);
    });

    let otherRuns = 0;
    const disposeOther = fw.effect(() => {
      other.read();
      otherRuns++;
    });

    try {
      enabled.write(true);
    } catch {}

    expect(iterations).toBeLessThanOrEqual(60);
    expect(enabled.read()).toBe(false);

    const iterationsAfterError = iterations;
    try {
      value.write(1000);
    } catch {}
    expect(value.read()).toBe(1000);
    expect(iterations).toBe(iterationsAfterError);

    const otherRunsBefore = otherRuns;
    other.write(1);
    expect(otherRuns).toBeGreaterThan(otherRunsBefore);

    disposeLoop();
    disposeOther();
  },
};
