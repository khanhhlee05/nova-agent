import type { ClientToolResult } from "@nova-agent/protocol";

type Waiter = { resolve: (result: ClientToolResult) => void; cleanup: () => void };

const key = (turnId: string, callId: string): string => `${turnId}\n${callId}`;

/**
 * Lookups a turn is waiting on the panel for, in memory for this process.
 *
 * A turn registers a call and gets a promise that always settles: with the
 * panel's answer, with a "did not answer in time" failure, or with a
 * "stopped" failure when the turn is aborted. An answer is accepted once, for
 * a call that is actually waiting, and nothing else can be delivered: the
 * turn id is random and only the turn's own client ever sees it.
 */
export class PendingClientCalls {
  private readonly waiting = new Map<string, Waiter>();

  get size(): number {
    return this.waiting.size;
  }

  wait(turnId: string, callId: string, timeoutMs: number, signal: AbortSignal): Promise<ClientToolResult> {
    const id = key(turnId, callId);
    return new Promise<ClientToolResult>((resolve) => {
      const fail = (error: string) => settle({ id: callId, ok: false, summary: "", data: null, rows: [], error });
      const onAbort = () => fail("The turn was stopped before the panel answered.");
      const timer = setTimeout(() => fail("The panel did not answer in time. The file may be large, or the Brightspace tab may be closed."), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.waiting.delete(id);
      };
      const settle = (result: ClientToolResult) => {
        cleanup();
        resolve(result);
      };
      // A second call under the same id replaces nothing: the first keeps waiting and the second fails at once.
      if (this.waiting.has(id)) {
        clearTimeout(timer);
        resolve({ id: callId, ok: false, summary: "", data: null, rows: [], error: "A lookup with this id is already waiting." });
        return;
      }
      this.waiting.set(id, { resolve: settle, cleanup });
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Delivers the panel's answer. False when no such call is waiting (already answered, timed out, or never asked). */
  deliver(turnId: string, result: ClientToolResult): boolean {
    const waiter = this.waiting.get(key(turnId, result.id));
    if (!waiter) return false;
    waiter.resolve(result);
    return true;
  }
}
