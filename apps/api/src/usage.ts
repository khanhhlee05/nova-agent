export type Reservation = { day: string; tokens: number };

/**
 * In-memory token accounting per UTC day, best effort: it lives in this
 * process, resets on restart, and is not shared between instances.
 *
 * A request reserves its worst-case budget synchronously before any model
 * call, so concurrent requests cannot all slip past the cap, then settles
 * to the real usage when the turn ends.
 */
export class UsageCounter {
  private readonly days = new Map<string, number>();

  constructor(private readonly dailyCap: number) {}

  private key(now: Date): string {
    return now.toISOString().slice(0, 10);
  }

  /** Charges `tokens` at once, or returns null when that would pass the cap. A cap of 0 means unlimited. */
  reserve(now: Date, tokens: number): Reservation | null {
    const day = this.key(now);
    const used = this.days.get(day) ?? 0;
    const amount = Math.max(0, tokens);
    if (this.dailyCap > 0 && used + amount > this.dailyCap) return null;
    this.days.set(day, used + amount);
    return { day, tokens: amount };
  }

  /** Replaces a reservation with what the turn actually used, on the reservation's own day. */
  settle(reservation: Reservation, actualTokens: number): void {
    const used = this.days.get(reservation.day) ?? 0;
    this.days.set(reservation.day, Math.max(0, used - reservation.tokens + Math.max(0, actualTokens)));
  }

  usedToday(now: Date): number {
    return this.days.get(this.key(now)) ?? 0;
  }

  remaining(now: Date): number {
    return this.dailyCap > 0 ? Math.max(0, this.dailyCap - this.usedToday(now)) : Number.POSITIVE_INFINITY;
  }
}
