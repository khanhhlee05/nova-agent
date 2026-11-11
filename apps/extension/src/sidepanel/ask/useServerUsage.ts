import { useEffect, useState } from "react";
import type { AskClient } from "./askClient";
import type { ServerUsage } from "./AskView";

/**
 * Asks the server how much of its daily allowance is used: once when the
 * Ask tab is first shown, and again after each answer (`tick` changes).
 * Null when there is no server, it did not answer, or it has no limit.
 */
export const useServerUsage = (client: AskClient | null, active: boolean, tick: number): ServerUsage | null => {
  const [usage, setUsage] = useState<ServerUsage | null>(null);
  useEffect(() => {
    if (!client || !active) return;
    const controller = new AbortController();
    void client
      .health(controller.signal)
      .then((health) => {
        if (controller.signal.aborted) return;
        setUsage(health.ok && health.usedToday !== undefined && health.dailyCap !== undefined && health.dailyCap > 0 ? { usedToday: health.usedToday, dailyCap: health.dailyCap } : null);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [active, client, tick]);
  return client ? usage : null;
};
