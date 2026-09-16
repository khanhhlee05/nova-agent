import { describe, expect, it } from "vitest";
import { UsageCounter } from "../../apps/api/src/usage";

const DAY = new Date("2026-09-08T14:00:00Z");
const NEXT_DAY = new Date("2026-09-09T02:00:00Z");

describe("UsageCounter", () => {
  it("refuses a reservation that would pass the cap and settles to actual usage", () => {
    const usage = new UsageCounter(3000);
    const first = usage.reserve(DAY, 2800);
    expect(first).toEqual({ day: "2026-09-08", tokens: 2800 });
    expect(usage.reserve(DAY, 2800)).toBeNull();
    expect(usage.usedToday(DAY)).toBe(2800);
    usage.settle(first as NonNullable<typeof first>, 144);
    expect(usage.usedToday(DAY)).toBe(144);
    expect(usage.reserve(DAY, 2800)).not.toBeNull();
    expect(usage.remaining(DAY)).toBe(3000 - 144 - 2800);
  });

  it("treats a cap of zero as unlimited", () => {
    const usage = new UsageCounter(0);
    for (let i = 0; i < 100; i++) expect(usage.reserve(DAY, 1_000_000)).not.toBeNull();
    expect(usage.remaining(DAY)).toBe(Number.POSITIVE_INFINITY);
  });

  it("never drives a day below zero and ignores negative amounts", () => {
    const usage = new UsageCounter(1000);
    const reservation = usage.reserve(DAY, 500) as NonNullable<ReturnType<UsageCounter["reserve"]>>;
    usage.settle(reservation, -50);
    expect(usage.usedToday(DAY)).toBe(0);
    usage.settle(reservation, 10);
    expect(usage.usedToday(DAY)).toBe(0);
    expect(usage.reserve(DAY, -5)).toEqual({ day: "2026-09-08", tokens: 0 });
  });

  it("settles a reservation on its own day even after midnight", () => {
    const usage = new UsageCounter(10_000);
    const reservation = usage.reserve(DAY, 2800) as NonNullable<ReturnType<UsageCounter["reserve"]>>;
    usage.settle(reservation, 300);
    expect(usage.usedToday(DAY)).toBe(300);
    expect(usage.usedToday(NEXT_DAY)).toBe(0);
  });
});
