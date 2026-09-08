import { COURSE_COLORS } from "@nova-agent/brightspace";

export type Theme = "light" | "dark";

export const THEMES: readonly Theme[] = ["light", "dark"];

export const isTheme = (value: unknown): value is Theme => value === "light" || value === "dark";

/** Puts the theme on the document root so portaled layers (menus, popovers, dialogs) pick it up too. */
export const applyTheme = (theme: Theme): void => {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
};

/**
 * Course colors are roles, not fixed hex values: a course keeps its slot and
 * each theme paints the slot with a swatch tuned for that ground. Colors not
 * in the palette (older snapshots) render as stored.
 */
export const courseSwatch = (color: string): string => {
  const index = (COURSE_COLORS as readonly string[]).indexOf(color);
  return index >= 0 ? `var(--course-${index}, ${color})` : color;
};
