export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sliding-window limiter for TikTok's per-second and per-minute caps. */
export class RateLimiter {
  private readonly secondWindow: number[] = [];
  private readonly minuteWindow: number[] = [];

  constructor(private readonly maxPerSecond: number, private readonly maxPerMinute: number) {}

  async acquire(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    for (;;) {
      const now = Date.now();
      prune(this.secondWindow, now, 1_000);
      prune(this.minuteWindow, now, 60_000);

      if (this.secondWindow.length < this.maxPerSecond && this.minuteWindow.length < this.maxPerMinute) {
        this.secondWindow.push(now);
        this.minuteWindow.push(now);
        return;
      }

      const waits: number[] = [];
      if (this.secondWindow.length >= this.maxPerSecond) waits.push(1_000 - (now - this.secondWindow[0]));
      if (this.minuteWindow.length >= this.maxPerMinute) waits.push(60_000 - (now - this.minuteWindow[0]));
      await sleep(Math.max(5, Math.min(...waits)));
    }
  }
}

function prune(window: number[], now: number, spanMs: number): void {
  while (window.length > 0 && now - window[0] >= spanMs) {
    window.shift();
  }
}

export function backoffDelayMs(attempt: number): number {
  const base = 500 * 2 ** attempt;
  return Math.min(base, 15_000) + Math.floor(Math.random() * 250);
}

// Rate-limit errors need a longer wait so TikTok's window can reset.
export function rateLimitDelayMs(attempt: number): number {
  const base = 15_000 * 2 ** attempt;
  return Math.min(base, 60_000) + Math.floor(Math.random() * 1_000);
}
