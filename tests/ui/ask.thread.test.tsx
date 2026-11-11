// @vitest-environment jsdom
import "./setup";
import type { AskEvent, ChatRequest } from "@nova-agent/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AskClient } from "../../apps/extension/src/sidepanel/ask/askClient";
import { MissionControl } from "../../apps/extension/src/sidepanel/MissionControl";
import { askProps, baseProps } from "../helpers/askHarness";
import { demoDashboard } from "../helpers/demoDashboard";

afterEach(cleanup);

const ask = (text: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: /ask nova a question/i }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /send question|stop answering/i }));
};

/** Each question starts a lookup and then waits until its own gate opens or it is aborted. */
const gatedClient = () => {
  const gates: (() => void)[] = [];
  const seen: ChatRequest[] = [];
  const client: AskClient = {
    async *ask(request, signal): AsyncIterable<AskEvent> {
      seen.push(request);
      const index = seen.length;
      yield { type: "tool_call", id: `c${index}`, name: "get_brief", input: {} };
      await new Promise<void>((resolve) => {
        gates.push(resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      if (signal.aborted) {
        yield { type: "error", code: "aborted", message: "Stopped.", retryable: true };
        return;
      }
      yield { type: "tool_result", id: `c${index}`, name: "get_brief", ok: true, summary: `Lookup ${index} done.`, rows: [] };
      yield { type: "text", delta: `Answer ${index}.` };
      yield { type: "done", model: "gated", usage: null, rounds: 2, grounded: true, corrected: false };
    },
    async health() {
      return { ok: true, configured: true, model: "gated", message: null };
    },
  };
  return { client, seen, open: (index: number) => gates[index]?.() };
};

describe("the thread under interruption", () => {
  it("does not leave a lookup spinning after Stop", async () => {
    const { dashboard, events } = await demoDashboard();
    const { client } = gatedClient();
    render(<MissionControl {...baseProps({ dashboard, ask: askProps(client, events) })} />);
    ask("First?");
    await screen.findByText("Looking up your workload…");
    fireEvent.click(screen.getByRole("button", { name: /stop answering/i }));
    await screen.findByText(/stopped before nova finished/i);
    expect(screen.queryByText("Looking up your workload…")).toBeNull();
    expect(screen.getByText("Could not look up your workload: stopped before it finished")).toBeTruthy();
  });

  it("lets a new question start right after the thread is cleared mid-answer, and the old answer cannot touch it", async () => {
    const { dashboard, events } = await demoDashboard();
    const { client, seen, open } = gatedClient();
    render(<MissionControl {...baseProps({ dashboard, ask: askProps(client, events) })} />);
    ask("First?");
    await screen.findByText("Looking up your workload…");
    fireEvent.click(screen.getByRole("button", { name: "Clear conversation" }));
    expect(screen.queryByText("First?")).toBeNull();
    // The composer is ready at once: no waiting for the cancelled answer to wind down.
    expect(screen.getByRole("button", { name: /send question/i })).toBeTruthy();
    ask("Second?");
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]?.history).toEqual([]);
    // Let the cancelled turn finish unwinding while the second is still waiting: the second stays "answering".
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole("button", { name: /stop answering/i })).toBeTruthy();
    expect(screen.queryByText("Stopped.")).toBeNull();
    open(1);
    await screen.findByText("Answer 2.");
    expect(screen.queryByText("Answer 1.")).toBeNull();
    expect(screen.getByText("Second?")).toBeTruthy();
    expect(screen.getByRole("button", { name: /send question/i })).toBeTruthy();
  });

  it("retries a failed question about one item with the same item", async () => {
    const { dashboard, events } = await demoDashboard();
    const seen: ChatRequest[] = [];
    const flaky: AskClient = {
      async *ask(request): AsyncIterable<AskEvent> {
        seen.push(request);
        if (seen.length === 1) {
          yield { type: "error", code: "upstream_error", message: "boom", retryable: true };
          return;
        }
        yield { type: "text", delta: "Second try worked." };
        yield { type: "done", model: "flaky", usage: null, rounds: 1, grounded: true, corrected: false };
      },
      async health() {
        return { ok: true, configured: true, model: "flaky", message: null };
      },
    };
    const state = askProps(flaky, events);
    const view = render(<MissionControl {...baseProps({ dashboard, preferences: { ...baseProps().preferences, activeTab: "focus" }, ask: state })} />);
    fireEvent.click(screen.getByRole("button", { name: /ask why/i }));
    view.rerender(<MissionControl {...baseProps({ dashboard, ask: state })} />);
    fireEvent.click(screen.getByRole("button", { name: /send question/i }));
    fireEvent.click(await screen.findByRole("button", { name: /retry/i }));
    await screen.findByText("Second try worked.");
    expect(seen[0]?.focus?.itemId).toBeTruthy();
    expect(seen[1]?.focus?.itemId).toBe(seen[0]?.focus?.itemId);
    expect(seen[1]?.message).toBe(seen[0]?.message);
    expect(seen[1]?.history).toEqual([]);
  });
});
