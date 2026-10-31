// @vitest-environment jsdom
import "./setup";
import "fake-indexeddb/auto";
import { FixtureTransport, buildDemoTenant, demoResolver } from "@nova-agent/brightspace";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { createStubHost } from "../../apps/extension/src/platform/host";
import { App } from "../../apps/extension/src/sidepanel/App";
import { createNovaDb, type NovaDb } from "../../apps/extension/src/storage/novaDb";
import type { TransportFactory } from "../../apps/extension/src/sync/syncCoordinator";
import { NOW } from "../helpers/demoDashboard";

let db: NovaDb | null = null;

afterEach(async () => {
  cleanup();
  await db?.delete();
  db = null;
});

const LONG = { timeout: 10_000 };

describe("changes feed: end to end", () => {
  it("keeps a read change until the next refresh and deletes a change for good", async () => {
    db = createNovaDb(`changes-${Date.now()}`);
    let clock = NOW;
    const factory: TransportFactory = (_mode, { now, demoScenario }) => new FixtureTransport(demoResolver(buildDemoTenant(now, demoScenario)));
    render(<App db={db} host={createStubHost()} now={() => clock} transportFactory={factory} autoSync={false} undoMs={400} />);

    const user = userEvent.setup();
    const refreshable = () => waitFor(() => expect((screen.getByRole("button", { name: /refresh now/i }) as HTMLButtonElement).disabled).toBe(false), LONG);

    // Baseline sync, then a second sync that carries the demo "changed" scenario.
    fireEvent.click(await screen.findByRole("button", { name: /explore with demo data/i }));
    await refreshable();
    clock = new Date(NOW.getTime() + 20 * 60_000);
    fireEvent.click(screen.getByRole("button", { name: /refresh now/i }));
    await refreshable();
    await user.click(screen.getByRole("tab", { name: /changes/i }));
    const deleteButtons = await screen.findAllByRole("button", { name: /^Delete change "/ }, LONG);
    const total = deleteButtons.length;
    expect(total).toBeGreaterThan(1);

    // Mark one read: it stays listed this session and the unread count drops by one.
    const readButtons = screen.getAllByRole("button", { name: /^Mark ".*" as read$/ });
    const readTitle = /^Mark "(.*)" as read$/.exec(readButtons[0]?.getAttribute("aria-label") ?? "")?.[1] as string;
    fireEvent.click(readButtons[0] as HTMLButtonElement);
    await waitFor(() => expect(screen.getByRole("button", { name: `Mark "${readTitle}" as unread` })).toBeTruthy());
    expect(screen.getAllByRole("button", { name: /^Delete change "/ })).toHaveLength(total);
    await waitFor(() => expect(screen.getByRole("tab", { name: /changes/i }).textContent).toContain(String(total - 1)));

    // Delete another, then Undo: it leaves the feed at once, focus moves to Undo, and nothing is removed from the database.
    const remaining = screen.getAllByRole("button", { name: /^Delete change "/ }).filter((button) => !button.getAttribute("aria-label")?.includes(readTitle));
    const deleteTitle = /^Delete change "(.*)"$/.exec(remaining[0]?.getAttribute("aria-label") ?? "")?.[1] as string;
    await user.click(remaining[0] as HTMLButtonElement);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Delete change "/ })).toHaveLength(total - 1));
    const undo = screen.getByRole("button", { name: /^undo$/i });
    expect(document.activeElement).toBe(undo);
    fireEvent.click(undo);
    expect(await screen.findByText(`Restored the change for "${deleteTitle}".`)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Delete change "/ })).toHaveLength(total);
    expect(await db?.changeEvents.count()).toBe(total);

    // Delete it again and let the Undo window close: now it is gone from the database too.
    fireEvent.click(screen.getByRole("button", { name: `Delete change "${deleteTitle}"` }));
    expect(await screen.findByText(`Deleted the change for "${deleteTitle}". Undo to restore it.`)).toBeTruthy();
    expect(screen.queryByText(/hidden until the next refresh/i)).toBeNull();
    await waitFor(() => expect(screen.queryByRole("button", { name: /^undo$/i })).toBeNull(), LONG);
    await waitFor(async () => expect(await db?.changeEvents.count()).toBe(total - 1));
    expect(screen.getAllByRole("button", { name: /^Delete change "/ })).toHaveLength(total - 1);

    // Next refresh: the read change leaves the feed, the deleted one does not come back.
    clock = new Date(NOW.getTime() + 40 * 60_000);
    fireEvent.click(screen.getByRole("button", { name: /refresh now/i }));
    await refreshable();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Delete change "/ })).toHaveLength(total - 2), LONG);
    expect(screen.queryByRole("button", { name: `Mark "${readTitle}" as unread` })).toBeNull();
    expect(screen.queryByRole("button", { name: `Delete change "${deleteTitle}"` })).toBeNull();
    // The read row is still stored (for dedupe and the badge), only filtered from the feed.
    expect(await db?.changeEvents.count()).toBe(total - 1);
  }, 30_000);
});
