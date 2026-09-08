import { useEffect, useState } from "react";

/** Ticks once a minute so relative times stay honest without re-rendering constantly. */
export const useNow = (intervalMs = 60_000, initial?: () => Date): Date => {
  const [now, setNow] = useState(() => (initial ? initial() : new Date()));
  useEffect(() => {
    const timer = setInterval(() => setNow(initial ? initial() : new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, initial]);
  return now;
};
