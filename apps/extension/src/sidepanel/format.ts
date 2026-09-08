import { differenceInCalendarDays, format, formatDistanceStrict, isSameYear } from "date-fns";

export const formatRelative = (iso: string | null, now: Date): string => {
  if (!iso) return "No due date";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  const diffMs = date.getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  if (abs < 60_000) return diffMs <= 0 ? "just now" : "in under a minute";
  const distance = formatDistanceStrict(date, now, { roundingMethod: "floor" });
  return diffMs < 0 ? `${distance} ago` : `in ${distance}`;
};

/** "Thu 11:59 PM" or "Thu, Sep 10, 11:59 PM" when the date is beyond this week. */
export const formatDeadline = (iso: string | null, now: Date): string => {
  if (!iso) return "No due date";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  const days = differenceInCalendarDays(date, now);
  if (days >= 0 && days < 7) return format(date, "EEE h:mm a");
  return format(date, isSameYear(date, now) ? "EEE, MMM d, h:mm a" : "MMM d, yyyy, h:mm a");
};

export const formatExact = (iso: string | null): string => {
  if (!iso) return "No due date";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "Unknown date" : format(date, "EEEE, MMMM d, yyyy 'at' h:mm a");
};

export const formatUpdated = (iso: string | null, now: Date): string => {
  if (!iso) return "Never refreshed";
  const date = new Date(iso);
  const diff = now.getTime() - date.getTime();
  if (diff < 60_000) return "Updated just now";
  if (diff < 3_600_000) return `Updated ${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `Updated ${Math.floor(diff / 3_600_000)}h ago`;
  return `Updated ${format(date, "MMM d, h:mm a")}`;
};

/** "just now", "4m ago", "2h ago", or an absolute time for older data. */
export const formatAge = (iso: string | null, now: Date): string => {
  if (!iso) return "never";
  const diff = now.getTime() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `on ${format(new Date(iso), "MMM d, h:mm a")}`;
};

export const formatDayHeader = (date: Date): { weekday: string; day: string } => ({ weekday: format(date, "EEE"), day: format(date, "d") });

export const formatTime = (iso: string): string => format(new Date(iso), "h:mm a");

export const formatDetected = (iso: string, now: Date): string => `Detected ${formatRelative(iso, now)}`;

export const pluralize = (count: number, singular: string, plural = `${singular}s`): string => `${count} ${count === 1 ? singular : plural}`;
