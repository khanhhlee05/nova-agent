/** In-memory token counter per UTC day. Slice 1 has no database; the counter resets with the process. */
export class UsageCounter {
  private readonly days = new Map<string, number>();

  constructor(private readonly dailyCap: number) {}

  private key(now: Date): string {
    return now.toISOString().slice(0, 10);
  }

  add(now: Date, tokens: number): void {
    const key = this.key(now);
    this.days.set(key, (this.days.get(key) ?? 0) + Math.max(0, tokens));
  }

  usedToday(now: Date): number {
    return this.days.get(this.key(now)) ?? 0;
  }

  remaining(now: Date): number {
    return Math.max(0, this.dailyCap - this.usedToday(now));
  }

  exhausted(now: Date): boolean {
    return this.dailyCap > 0 && this.remaining(now) <= 0;
  }
}
