/**
 * Injectable clock for testable time.
 */

import type { Clock } from "../types.js";

/** Default clock using Date.now(). */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Fixed clock for testing — always returns the same time. */
export class FixedClock implements Clock {
  constructor(private readonly fixedTime: Date) {}

  now(): Date {
    return this.fixedTime;
  }
}

/** The default system clock instance. */
export const systemClock = new SystemClock();
