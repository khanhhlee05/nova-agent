// @vitest-environment jsdom
import "./setup";
import "fake-indexeddb/auto";
import { FixtureTransport, buildDemoTenant, demoResolver } from "@nova-agent/brightspace";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { createStubHost } from "../../apps/extension/src/platform/host";
import { App } from "../../apps/extension/src/sidepanel/App";
import { createNovaDb, type NovaDb } from "../../apps/extension/src/storage/novaDb";
import { getSyncStatus, listChangeEvents, listSnapshots } from "../../apps/extension/src/storage/repositories";
import type { TransportFactory } from "../../apps/extension/src/sync/syncCoordinator";
import { NOW } from "../helpers/demoDashboard";

let db: NovaDb | null = null;

afterEach(async () => {
  cleanup();
  await db?.delete();
  db = null;
});

const LONG = { timeout: 10_000 };
const TITLE = "Study for the midterm";

describe("your own deadlines: end to end", () => {
  it("adds from a picked day, survives refreshes without producing a change, and deletes with Undo", { timeout: 30_000 }, async () => {
    db = createNovaDb(`personal-${Date.now()}`);
    let clock = NOW;
    const factory: TransportFactory = (_mode, { now, demoScenario }) => new FixtureTransport(demoResolver(buildDemoTenant(now, demoScenario)));
    render(<App db={db} host={createStubHost()} now={() => clock} transportFactory={factory} autoSync={false} undoMs={400} />);
    const synced = async (at: Date) => {
      await waitFor(async () => expect((await getSyncStatus(db as NovaDb)).lastSuccessfulSyncAt).toBe(at.toISOString()), LONG);
      await waitFor(() => expect((screen.getByRole("button", { name: /refresh now/i }) as HTMLButtonElement).disabled).toBe(false), LONG);
    };

    fireEvent.click(await screen.findByRole("button", { name: /explore with demo data/i }));
    await synced(clock);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /week/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Thursday, September 10/ }, LONG));
    fireEvent.click(screen.getAllByRole("button", { name: /add your own deadline/i })[0] as HTMLButtonElement);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: TITLE } });
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "18:00" } });
    fireEvent.click(screen.getByRole("button", { name: /^add deadline$/i }));

    const row = await screen.findByRole("button", { name: new RegExp(`^${TITLE}, added by you, no course, 6:00 PM$`) }, LONG);
    expect(within(row).getByText("Added by you")).toBeTruthy();
    expect(screen.getByText(/Added "Study for the midterm" to your Week tab/)).toBeTruthy();

    // Two refreshes (the second carries the demo "changed" scenario). The deadline stays, no snapshot or change event carries it.
    for (const minutes of [20, 40]) {
      clock = new Date(NOW.getTime() + minutes * 60_000);
      fireEvent.click(screen.getByRole("button", { name: /refresh now/i }));
      await synced(clock);
    }
    expect(screen.getByRole("button", { name: new RegExp(`^${TITLE}, added by you`) })).toBeTruthy();
    const scope = (await getSyncStatus(db)).scope as string;
    expect((await listSnapshots(db, scope)).every((snapshot) => snapshot.items.every((item) => item.title !== TITLE))).toBe(true);
    const events = await listChangeEvents(db, scope);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => (event.after?.title ?? event.before?.title) !== TITLE)).toBe(true);
    expect(await db.personalItems.count()).toBe(1);

    // Mark done, then delete and undo, then delete for good.
    await user.click(screen.getByRole("button", { name: new RegExp(`^${TITLE}, added by you`) }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /^mark done$/i }));
    await screen.findByRole("button", { name: new RegExp(`^${TITLE}, added by you, no course, 6:00 PM, done$`) }, LONG);
    // The popover stays open after Mark done; close it before opening the row again.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: new RegExp(`^${TITLE}, added by you`) }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(screen.queryByRole("button", { name: new RegExp(`^${TITLE}, added by you`) })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /^undo$/i }));
    expect(await screen.findByRole("button", { name: new RegExp(`^${TITLE}, added by you`) }, LONG)).toBeTruthy();
    expect(await db.personalItems.count()).toBe(1);

    await user.click(screen.getByRole("button", { name: new RegExp(`^${TITLE}, added by you`) }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /^delete$/i }));
    await waitFor(async () => expect(await db?.personalItems.count()).toBe(0), { timeout: 5_000 });
    expect(screen.queryByRole("button", { name: new RegExp(`^${TITLE}, added by you`) })).toBeNull();
  });
});
