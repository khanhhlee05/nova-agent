import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Session-only dismissals.
 *
 * A student can hide any task, change event, or banner to focus on the rest.
 * Nothing is persisted: closing the panel forgets every dismissal, and any
 * refresh (an explicit refresh action or a new snapshot arriving) restores
 * everything, so the panel always returns to what Brightspace actually says.
 */
export type SessionDismissals = {
  items: ReadonlySet<string>;
  events: ReadonlySet<string>;
  banners: ReadonlySet<string>;
};

export const EMPTY_DISMISSALS: SessionDismissals = { items: new Set(), events: new Set(), banners: new Set() };

export const countDismissed = (dismissals: SessionDismissals): number =>
  dismissals.items.size + dismissals.events.size + dismissals.banners.size;

export type DismissalControls = {
  dismissals: SessionDismissals;
  dismissItem: (key: string) => void;
  dismissEvent: (id: string) => void;
  dismissBanner: (id: string) => void;
  restoreAll: () => void;
};

const withAdded = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  if (set.has(id)) return set;
  const next = new Set(set);
  next.add(id);
  return next;
};

/** `resetKey` should change whenever fresh data arrives (for example the snapshot's capturedAt). */
export const useSessionDismissals = (resetKey: string | null): DismissalControls => {
  const [dismissals, setDismissals] = useState<SessionDismissals>(EMPTY_DISMISSALS);

  useEffect(() => {
    setDismissals(EMPTY_DISMISSALS);
  }, [resetKey]);

  const dismissItem = useCallback((key: string) => setDismissals((prev) => ({ ...prev, items: withAdded(prev.items, key) })), []);
  const dismissEvent = useCallback((id: string) => setDismissals((prev) => ({ ...prev, events: withAdded(prev.events, id) })), []);
  const dismissBanner = useCallback((id: string) => setDismissals((prev) => ({ ...prev, banners: withAdded(prev.banners, id) })), []);
  const restoreAll = useCallback(() => setDismissals(EMPTY_DISMISSALS), []);

  return useMemo(() => ({ dismissals, dismissItem, dismissEvent, dismissBanner, restoreAll }), [dismissals, dismissItem, dismissEvent, dismissBanner, restoreAll]);
};
